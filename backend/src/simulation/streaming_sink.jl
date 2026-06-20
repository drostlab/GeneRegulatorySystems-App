"""
    StreamingSink

Direct Arrow storage with an in-process live tail for simulation events.

Implements columnar Arrow storage (matching ExperimentTool format) with:
1. Time-window-based progress reporting via SimulationController
2. A bounded live tail for selected species
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
using Logging
using Arrow
using Tables
import ..SimulationControl: check_control!, enter_path!, record_live_event!, update_live_progress!

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

Direct Arrow sink with optional live state via SimulationController.

# Fields
- `location::String`: Directory for Arrow files
- `i::Int`: Episode counter
- `index::Vector`: Execution segment metadata
- `threshold::Int`: Event buffer size before flush (default 200k)
- `channels::Dict{String, Channel}`: Buffered events by channel
- `controller`: SimulationController for pause/progress/live timeseries (duck-typed)
- `i_to_path::Dict{Int, String}`: Episode index to path mapping
- `frame_count::Int`: Running count of frames for progress reporting
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
    frame_count::Int = 0
    segment_progress::Dict{Tuple{String,Float64}, SegmentProgress} = Dict{Tuple{String,Float64}, SegmentProgress}()
    total_duration::Float64 = 0.0
    completed_duration::Float64 = 0.0
    current_segment_key::Union{Tuple{String,Float64}, Nothing} = nothing
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
    (sink::StreamingSimulationSink)(state; path, primitive!, from, into, _...)

Sink interface (callable struct). Called for each state transition.
Accumulates events, checks lifecycle control, and updates live progress/timeseries.
"""
function (sink::StreamingSimulationSink)(;
    path,
    into = nothing,
    flush = nothing,
    _...,
)
    matching = flush === true ? into : flush
    matching !== nothing && flush!(sink; matching, finalize = false)
end

function (sink::StreamingSimulationSink)(
    state;
    path,
    primitive!,
    from,
    into = nothing,
    _...,
)
    check_control_if_needed(sink)
    !isnothing(sink.controller) && enter_path!(sink.controller, path, Float64(from))

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
        push!(sink.index, (; sink.i, path, from, to, model, label, count = 0, into = ""))
        sink.i_to_path[sink.i] = path

        update_live!(sink, to)
        return
    end

    # Accumulate events from this state
    channel = get!(Channel, sink.channels, into)
    count = 0

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

        !isnothing(sink.controller) && record_live_event!(sink.controller, path, t, name, value)
    end

    sink.frame_count += 1

    # Record execution segment metadata
    push!(sink.index, (; sink.i, path, from, to, model, label, count, into))
    sink.i_to_path[sink.i] = path

    update_live!(sink, to)
end

# ============================================================================
# Pause Support
# ============================================================================

function check_control_if_needed(sink::StreamingSimulationSink)
    isnothing(sink.controller) && return
    check_control!(sink.controller)
end

# ============================================================================
# Live progress
# ============================================================================

function update_live!(sink::StreamingSimulationSink, current_time::Float64)
    isnothing(sink.controller) && return
    total_progress = compute_total_progress(sink, current_time)
    update_live_progress!(sink.controller, current_time, sink.frame_count, total_progress)
end

# ============================================================================
# Flushing to Disk
# ============================================================================

"""
    flush!(sink)

Flush matching event channels to Arrow files. When `finalize` is true, also
complete progress tracking.
"""
function flush!(sink::StreamingSimulationSink; matching = nothing, finalize::Bool = true)
    sink.i > 0 || return
    @info "[StreamingSink] Flushing channels" matching finalize

    # Mark the final segment as completed only when finalizing the whole sink.
    if finalize && sink.current_segment_key !== nothing
        mark_segment_completed!(sink, sink.current_segment_key)
        sink.current_segment_key = nothing
    end

    for into in keys(sink.channels)
        if matching === nothing || startswith(into, matching)
            flush_channel!(sink, into)
        end
    end

    write_index!(sink)

    finalize || return

    if !isnothing(sink.controller) && !isempty(sink.index)
        update_live!(sink, maximum(row.to for row in sink.index))
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
