"""
    StreamingSink

Direct Arrow storage with WebSocket streaming for simulation events.

Implements columnar Arrow storage (matching ExperimentTool format) with:
1. Time-window-based progress reporting via SimulationController
2. Filtered timeseries streaming (only subscribed species)
3. Pause/resume checkpoint at each trace callback
4. Direct file I/O (no dependency on ExperimentTool.artifact system)

Storage format:
- `index.arrow`: Metadata about execution paths
- `events_*.arrow`: Event columns (i, t, name, value) for each channel
"""
module StreamingSink

using GeneRegulatorySystems
using GeneRegulatorySystems.Models
using GeneRegulatorySystems.Models.Scheduling
using HTTP
import HTTP: send
using JSON
using Logging
using Arrow
using Tables

import ..GapTracking: GapTracker, register_episode!, check_gap, check_synthetic_start

export StreamingSimulationSink, flush!

# ============================================================================
# Types
# ============================================================================

"""
    SimulationFrame

A point in time with sparse species state changes.
"""
@kwdef struct SimulationFrame
    path::String
    t::Float64
    counts::Dict{String, Int}
end

"""
    Channel

Accumulates events for a single execution channel.
Matches ExperimentTool.Channel format for efficient Arrow columnar storage.
"""
@kwdef struct Channel
    is::Vector{Int64} = Int64[]
    ts::Vector{Float64} = Float64[]
    names::Vector{Symbol} = Symbol[]
    values::Vector{Int64} = Int64[]
end

"""
    SegmentProgress

Per-segment progress tracking info.

- `from`/`to`: time range of the segment
- `duration`: `to - from` (precomputed)
"""
@kwdef struct SegmentProgress
    from::Float64
    to::Float64
    duration::Float64
    completed::Bool = false
end

"""
    StreamingSimulationSink

Direct Arrow sink with optional WebSocket streaming via SimulationController.

# Fields
- `location::String`: Directory for Arrow files
- `i::Int`: Episode counter
- `index::Vector`: Execution segment metadata
- `threshold::Int`: Event buffer size before flush (default 200k)
- `channels::Dict{String, Channel}`: Buffered events by channel
- `controller`: SimulationController for pause/progress/timeseries (duck-typed)
- `i_to_path::Dict{Int, String}`: Episode index to path mapping
- `stream_interval_ns::UInt64`: Minimum nanoseconds between WS streaming updates (wall-clock)
- `last_stream_ns::UInt64`: Wall-clock time (ns) of the last stream update
- `pending_timeseries::Dict`: Accumulated timeseries for subscribed species since last stream
- `frame_count::Int`: Running count of frames for progress reporting
- `gap_tracker::GapTracker`: Shared gap detection logic for timeseries continuity
- `segment_progress::Dict{Tuple{String,Float64}, SegmentProgress}`: Per-segment progress keyed by (execution_path, from)
- `total_duration::Float64`: Sum of all segment durations (for computing total progress)
- `completed_duration::Float64`: Sum of completed segment durations (for fast progress computation)
- `current_segment_key::Union{Tuple{String,Float64}, Nothing}`: Key of the currently active segment
"""
@kwdef mutable struct StreamingSimulationSink
    location::String
    i::Int = 0
    index::Vector = []
    threshold::Int = 200000
    channels::Dict{String, Channel} = Dict{String, Channel}()
    controller::Any = nothing
    i_to_path::Dict{Int, String} = Dict{Int, String}()
    stream_interval_ns::UInt64 = UInt64(500_000_000)  # 500ms wall-clock
    last_stream_ns::UInt64 = time_ns()
    pending_timeseries::Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}} = Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}}()
    frame_count::Int = 0
    gap_tracker::GapTracker = GapTracker()
    segment_progress::Dict{Tuple{String,Float64}, SegmentProgress} = Dict{Tuple{String,Float64}, SegmentProgress}()
    total_duration::Float64 = 0.0
    completed_duration::Float64 = 0.0
    current_segment_key::Union{Tuple{String,Float64}, Nothing} = nothing
    """Per-(species, path) prev_end tracker for species-level gap detection, matching the HTTP path."""
    species_path_prev_end::Dict{Tuple{Symbol, String}, Float64} = Dict{Tuple{Symbol, String}, Float64}()
end

"""
    set_segments!(sink, segments)

Initialise per-segment progress tracking from the schedule's timeline segments.
Each segment is a NamedTuple or struct with `execution_path`, `from`, `to`.
"""
function set_segments!(sink::StreamingSimulationSink, segments)
    empty!(sink.segment_progress)
    sink.total_duration = 0.0
    sink.completed_duration = 0.0
    for seg in segments
        dur = max(seg.to - seg.from, 0.0)
        key = (seg.execution_path, seg.from)
        sink.segment_progress[key] = SegmentProgress(from=seg.from, to=seg.to, duration=dur)
        sink.total_duration += dur
    end
    @debug "[StreamingSink] Segment progress initialised" n_segments=length(segments) total_duration=sink.total_duration
end

"""
    compute_total_progress(sink, current_time) -> Float64

Compute overall simulation progress (0.0–1.0) from per-segment tracking.
"""
function compute_total_progress(sink::StreamingSimulationSink, current_time::Float64)::Float64
    sink.total_duration <= 0.0 && return 0.0

    # Start with already completed segments
    progress_duration = sink.completed_duration

    # Add partial progress for the current segment
    key = sink.current_segment_key
    if key !== nothing
        seg = get(sink.segment_progress, key, nothing)
        if seg !== nothing && !seg.completed && seg.duration > 0.0
            frac = clamp((current_time - seg.from) / seg.duration, 0.0, 1.0)
            progress_duration += seg.duration * frac
        end
    end

    return clamp(progress_duration / sink.total_duration, 0.0, 1.0)
end

"""
    mark_segment_completed!(sink, key)

Mark a segment as completed and accumulate its duration.
"""
function mark_segment_completed!(sink::StreamingSimulationSink, key::Tuple{String,Float64})
    seg = get(sink.segment_progress, key, nothing)
    seg === nothing && return
    seg.completed && return
    sink.segment_progress[key] = SegmentProgress(from=seg.from, to=seg.to, duration=seg.duration, completed=true)
    sink.completed_duration += seg.duration
end

# ============================================================================
# Core Sink Callback
# ============================================================================

"""
    (sink::StreamingSimulationSink)(into, state; path, primitive!, from, seed, _...)

Sink interface (callable struct). Called for each state transition.
Accumulates events, checks pause, reports progress, and streams filtered timeseries.
"""
function (sink::StreamingSimulationSink)(into, state; path, primitive!, from, seed, _...)
    # Check pause before processing
    check_pause_if_needed(sink)

    # Track which segment is currently executing
    segment_key = (path, from)
    if haskey(sink.segment_progress, segment_key)
        # Mark previous segment completed if switching
        prev = sink.current_segment_key
        if prev !== nothing && prev !== segment_key
            mark_segment_completed!(sink, prev)
        end
        sink.current_segment_key = segment_key
    end

    sink.i += 1
    to = Models.t(state)
    model = primitive!.path
    label = haskey(primitive!.bindings, :label) ? primitive!.bindings[:label] : ""

    # Record index metadata (no output channel)
    if into === nothing
        @debug "[StreamingSink] Index entry (no output)" i=sink.i path=path
        push!(sink.index, (; sink.i, path, from, to, model, label, count = 0, into = "", seed))
        sink.i_to_path[sink.i] = path

        # Register with gap tracker for bridging runs (step-based schedules).
        # Do NOT call register_episode! for output episodes here — that happens below.
        if from < to
            register_episode!(sink.gap_tracker, path, from, to)
        end
        return
    end

    # Accumulate events from this state
    channel = get!(Channel, sink.channels, into)
    count = 0
    episode_species = Set{Symbol}()  # species that produced events in this episode

    # Per-species gap detection + synthetic start + endpoint injection.
    # Mirrors load_events_as_timeseries which iterates per (species, path) with its own prev_end.
    if !isnothing(sink.controller)
        for sp in sink.controller.subscribed_species
            sp_prev_end = get(sink.species_path_prev_end, (sp, path), NaN)

            # Gap detection
            (insert_gap, gap_t_start, gap_t_end) = check_gap(sink.gap_tracker, path, from, sp_prev_end)
            if insert_gap
                species_dict = get!(sink.pending_timeseries, sp) do
                    Dict{String, Vector{Tuple{Float64, Int}}}()
                end
                series = get!(species_dict, path) do; Tuple{Float64, Int}[] end
                if isempty(series) || series[end][2] != Int64(-1)
                    push!(series, (gap_t_start, Int64(-1)))
                    push!(series, (gap_t_end, Int64(-1)))
                end
            end
        end
    end

    Models.each_event(state) do t::Float64, name::Symbol, value::Int64
        # Flush buffer if threshold reached
        if length(channel.values) >= sink.threshold
            @debug "[StreamingSink] Flushing channel (threshold)" into=into
            flush_channel!(sink, into)
            channel = sink.channels[into] = Channel()
        end

        push!(channel.is, sink.i)
        push!(channel.ts, t)
        push!(channel.names, name)
        push!(channel.values, value)
        count += 1

        accumulate_subscribed(sink, name, path, t, value, episode_species)

        # Stream inside the event loop on wall-clock interval
        if time_ns() - sink.last_stream_ns >= sink.stream_interval_ns
            check_pause_if_needed(sink)
            stream_update(sink, t)
        end
    end

    sink.frame_count += 1

    # Synthetic start-point: for the first episode on a path, duplicate the first
    # real data point back to the bridging run start.
    if !isnothing(sink.controller)
        for sp in sink.controller.subscribed_species
            sp_prev_end = get(sink.species_path_prev_end, (sp, path), NaN)
            (insert_start, start_t) = check_synthetic_start(sink.gap_tracker, path, from, sp_prev_end)
            if insert_start
                sd = get(sink.pending_timeseries, sp, nothing)
                isnothing(sd) && continue
                series = get(sd, path, nothing)
                (isnothing(series) || isempty(series)) && continue
                series[1][2] == Int64(-1) && continue
                pushfirst!(series, (start_t, series[1][2]))
            end
        end
    end

    # Endpoint injection: hold each subscribed species' last value to the episode end time.
    # Only for species that actually produced events in THIS episode.
    if !isnothing(sink.controller) && to > from
        for sp in episode_species
            sd = get(sink.pending_timeseries, sp, nothing)
            isnothing(sd) && continue
            series = get(sd, path, nothing)
            (isnothing(series) || isempty(series)) && continue
            last_t, last_v = series[end]
            if last_v != Int64(-1) && last_t < to
                push!(series, (to, last_v))
            end
        end
    end

    # Update per-(species, path) prev_end only for species that had events in this episode.
    if !isnothing(sink.controller)
        for sp in episode_species
            sink.species_path_prev_end[(sp, path)] = to > 0.0 ? to : from
        end
    end

    # Record execution segment metadata
    push!(sink.index, (; sink.i, path, from, to, model, label, count, into, seed))
    sink.i_to_path[sink.i] = path

    # Register episode with gap tracker
    register_episode!(sink.gap_tracker, path, from, to)

    # Stream at episode boundary if wall-clock interval elapsed.
    if time_ns() - sink.last_stream_ns >= sink.stream_interval_ns
        stream_update(sink, to)
    end
end

# ============================================================================
# Pause Support
# ============================================================================

function check_pause_if_needed(sink::StreamingSimulationSink)
    isnothing(sink.controller) && return
    ctrl = sink.controller
    ctrl.paused || return

    # Flush buffered events to disk before blocking so paused results are loadable
    @info "[StreamingSink] Flushing before pause"
    for into in collect(keys(sink.channels))
        flush_channel!(sink, into)
    end

    lock(ctrl.pause_condition) do
        while ctrl.paused
            @info "[StreamingSink] Simulation paused, blocking..."
            wait(ctrl.pause_condition)
        end
    end
end

# ============================================================================
# Subscribed Species Streaming
# ============================================================================

"""
Accumulate a data point for subscribed species into the pending buffer.
"""
function accumulate_subscribed(sink::StreamingSimulationSink, name::Symbol, path::String, t::Float64, value::Int64, episode_species::Set{Symbol})
    isnothing(sink.controller) && return
    name in sink.controller.subscribed_species || return

    species_dict = get!(sink.pending_timeseries, name) do
        Dict{String, Vector{Tuple{Float64, Int}}}()
    end
    series = get!(species_dict, path) do; Tuple{Float64, Int}[] end
    push!(series, (t, value))
    push!(episode_species, name)
end

"""
Send accumulated timeseries + progress to WS client, then clear the buffer.
"""
function stream_update(sink::StreamingSimulationSink, current_time::Float64)
    isnothing(sink.controller) && return
    ctrl = sink.controller
    ws = lock(ctrl.ws_lock) do; ctrl.ws_ref[]; end
    isnothing(ws) && return

    sink.last_stream_ns = time_ns()

    # Send progress
    total_progress = compute_total_progress(sink, current_time)
    @info "[StreamingSink] Streaming update" current_time=current_time frame_count=sink.frame_count total_progress=total_progress subscribed=length(ctrl.subscribed_species) pending=length(sink.pending_timeseries)
    ws_send(ws, Dict(
        "type" => "progress",
        "simulation_id" => ctrl.simulation_id,
        "current_time" => current_time,
        "frame_count" => sink.frame_count,
        "total_progress" => total_progress
    ))

    # Send timeseries if any accumulated
    if !isempty(sink.pending_timeseries)
        n_points = sum(sum(length(pts) for pts in values(pd)) for pd in values(sink.pending_timeseries))
        @info "[StreamingSink] Sending timeseries" species=length(sink.pending_timeseries) points=n_points
        ws_send_timeseries(ws, ctrl.simulation_id, sink.pending_timeseries)
        empty!(sink.pending_timeseries)
    end
end

function ws_send(ws::HTTP.WebSocket, data::Dict)
    try
        send(ws, JSON.json(data))
    catch e
        @warn "[StreamingSink] WS send failed" exception=string(e)
    end
end

function ws_send_timeseries(ws::HTTP.WebSocket, simulation_id::String,
                             timeseries::Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}})
    # Convert to JSON-friendly: { species: { path: [[t, v], ...] } }
    data = Dict{String, Dict{String, Vector{Vector{Any}}}}()
    for (species, path_data) in timeseries
        sp = String(species)
        data[sp] = Dict{String, Vector{Vector{Any}}}()
        for (path, points) in path_data
            data[sp][path] = [[t, v] for (t, v) in points]
        end
    end

    ws_send(ws, Dict(
        "type" => "timeseries",
        "simulation_id" => simulation_id,
        "data" => data
    ))
end

# ============================================================================
# Flushing to Disk
# ============================================================================

"""
    flush!(sink)

Flush all accumulated events to Arrow files. Sends final timeseries update.
"""
function flush!(sink::StreamingSimulationSink)
    sink.i > 0 || return
    @info "[StreamingSink] Flushing all channels"

    # Mark the final segment as completed
    if sink.current_segment_key !== nothing
        mark_segment_completed!(sink, sink.current_segment_key)
        sink.current_segment_key = nothing
    end

    for into in keys(sink.channels)
        flush_channel!(sink, into)
    end

    write_index!(sink)

    # Final timeseries flush
    if !isempty(sink.pending_timeseries) && !isnothing(sink.controller)
        ctrl = sink.controller
        ws = lock(ctrl.ws_lock) do; ctrl.ws_ref[]; end
        if !isnothing(ws)
            ws_send_timeseries(ws, ctrl.simulation_id, sink.pending_timeseries)
        end
        empty!(sink.pending_timeseries)
    end
end

"""
Write the current index metadata to `index.arrow`, overwriting any previous version.
Called incrementally on every channel flush and at final flush.
"""
function write_index!(sink::StreamingSimulationSink)
    isempty(sink.index) && return
    index = Tables.columntable(sink.index)
    index_file = joinpath(sink.location, "index.arrow")
    Arrow.write(index_file, (;
        index.i,
        index.path,
        index.from,
        index.to,
        model = Arrow.DictEncode(index.model),
        label = Arrow.DictEncode(index.label),
        index.count,
        into = Arrow.DictEncode(index.into),
        index.seed,
    ))
    @debug "[StreamingSink] Wrote index file" index_file episodes=length(sink.index)
end

"""
Flush a single channel's buffered events to disk.
"""
function flush_channel!(sink::StreamingSimulationSink, into::String)
    channel = pop!(sink.channels, into)
    filename = joinpath(sink.location, "events$into.stream.arrow")

    @info "[StreamingSink] Flushing channel" into=into events=length(channel.ts)

    events = (;
        i = channel.is,
        t = channel.ts,
        name = channel.names,
        value = channel.values,
    )

    if isfile(filename)
        Arrow.append(filename, events)
    else
        Arrow.write(filename, events, file = false)
    end

    write_index!(sink)
end

end # module
