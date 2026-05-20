"""
    StreamingSink

Direct Arrow storage with WebSocket streaming for simulation events.

Thread-safe sink: producers (one task per parallel branch) serialise on
`sink.lock`. WebSocket sends happen *outside* the lock so a slow client never
blocks producer threads.

Storage format:
- `index.arrow`: per-episode metadata
- `events_<into>.stream.arrow`: event columns (i, t, name, value)
"""
module StreamingSink

using GeneRegulatorySystems
using GeneRegulatorySystems.Models
using GeneRegulatorySystems.Models.Scheduling
using JSON
using Logging
using Arrow
using Tables

import ..GapTracking: GapTracker, register_episode!, check_gap, check_synthetic_start
import ..SimulationControl: SimulationController, send!, check_pause!

export StreamingSimulationSink, flush!, set_segments!, frame_count

# ============================================================================
# Value types
# ============================================================================

"""
    SimulationFrame

A point in time with sparse species state changes. Kept for external imports.
"""
@kwdef struct SimulationFrame
    path::String
    t::Float64
    counts::Dict{String, Int}
end

"""
    EventBuffer

Per-`into` columnar buffer matching the on-disk Arrow event format.
Renamed from the old `Channel` to stop shadowing `Base.Channel`.
"""
@kwdef struct EventBuffer
    is::Vector{Int64}     = Int64[]
    ts::Vector{Float64}   = Float64[]
    names::Vector{Symbol} = Symbol[]
    values::Vector{Int64} = Int64[]
end

Base.length(b::EventBuffer) = length(b.values)

const IndexEntry = @NamedTuple{
    i::Int, path::String, from::Float64, to::Float64,
    model::String, label::String, count::Int, into::String, seed::Any,
}

"""
    SegmentProgress

Per-segment progress. `high_water` is the latest event time observed in this
segment; `completed` flips when the segment's trace callback returns.
"""
mutable struct SegmentProgress
    from::Float64
    to::Float64
    duration::Float64
    high_water::Float64
    completed::Bool
end
SegmentProgress(from::Float64, to::Float64) =
    SegmentProgress(from, to, max(to - from, 0.0), from, false)

# ============================================================================
# Sub-state groups (all access serialised by `sink.lock`)
# ============================================================================

const PendingTimeseries = Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}}

"""Episode-level mutable state and disk-bound buffers."""
@kwdef mutable struct DiskState
    location::String
    threshold::Int = 200_000
    next_episode_i::Int = 0
    index::Vector{IndexEntry} = IndexEntry[]
    buffers::Dict{String, EventBuffer} = Dict{String, EventBuffer}()
    frame_count::Int = 0
end

"""WebSocket-bound buffers and continuity tracking."""
@kwdef mutable struct StreamState
    stream_interval_ns::UInt64 = UInt64(500_000_000)  # 500 ms
    last_stream_ns::UInt64 = time_ns()
    pending::PendingTimeseries = PendingTimeseries()
    gap_tracker::GapTracker = GapTracker()
    species_path_prev_end::Dict{Tuple{Symbol, String}, Float64} =
        Dict{Tuple{Symbol, String}, Float64}()
end

"""
Per-branch progress: `active` is the set of segment keys currently being
processed. With parallel branches, multiple segments are active simultaneously,
each on its own task.
"""
@kwdef mutable struct ProgressState
    segments::Dict{Tuple{String, Float64}, SegmentProgress} =
        Dict{Tuple{String, Float64}, SegmentProgress}()
    total_duration::Float64 = 0.0
    completed_duration::Float64 = 0.0
    active::Set{Tuple{String, Float64}} = Set{Tuple{String, Float64}}()
end

"""
    StreamingSimulationSink

Thread-safe sink. The callable form `(sink)(into, state; …)` is invoked once
per `Primitive` segment by the schedule. Under parallel branches it is called
concurrently from multiple tasks; all internal mutation runs under `lock`.
"""
mutable struct StreamingSimulationSink
    lock::ReentrantLock
    controller::Union{Nothing, SimulationController}
    disk::DiskState
    stream::StreamState
    progress::ProgressState
end

function StreamingSimulationSink(;
    location::String,
    controller::Union{Nothing, SimulationController} = nothing,
    threshold::Int = 200_000,
    stream_interval_ns::UInt64 = UInt64(500_000_000),
)
    StreamingSimulationSink(
        ReentrantLock(),
        controller,
        DiskState(; location, threshold),
        StreamState(; stream_interval_ns),
        ProgressState(),
    )
end

"""Read the live frame count. Caller does not need to hold the lock."""
frame_count(sink::StreamingSimulationSink) = lock(sink.lock) do
    sink.disk.frame_count
end

# ============================================================================
# Segment progress setup
# ============================================================================

"""
    set_segments!(sink, segments)

Initialise per-segment progress tracking from the schedule's timeline segments.
Each segment is expected to have `execution_path`, `from`, `to` fields.
"""
function set_segments!(sink::StreamingSimulationSink, segments)
    lock(sink.lock) do
        empty!(sink.progress.segments)
        empty!(sink.progress.active)
        sink.progress.total_duration = 0.0
        sink.progress.completed_duration = 0.0
        for seg in segments
            key = (seg.execution_path, seg.from)
            sp = SegmentProgress(Float64(seg.from), Float64(seg.to))
            sink.progress.segments[key] = sp
            sink.progress.total_duration += sp.duration
        end
        @debug "[StreamingSink] Segment progress initialised" n=length(segments) total=sink.progress.total_duration
    end
end

function _total_progress(progress::ProgressState)
    progress.total_duration <= 0.0 && return 0.0
    partial = 0.0
    for key in progress.active
        seg = progress.segments[key]
        seg.completed && continue
        partial += clamp(seg.high_water - seg.from, 0.0, seg.duration)
    end
    return clamp((progress.completed_duration + partial) / progress.total_duration, 0.0, 1.0)
end

function _complete_segment!(progress::ProgressState, key::Tuple{String, Float64})
    seg = get(progress.segments, key, nothing)
    isnothing(seg) && return
    seg.completed && return
    seg.completed = true
    seg.high_water = seg.to
    progress.completed_duration += seg.duration
    delete!(progress.active, key)
end

# ============================================================================
# Top-level callback
# ============================================================================

"""
    (sink)(into, state; path, primitive!, from, seed, _...)

Sink interface. Called once per `Primitive` segment, possibly concurrently
from branch tasks. Pause is honoured *before* acquiring the sink lock so a
paused producer doesn't block other branches. WebSocket sends happen *after*
the lock is released.
"""
function (sink::StreamingSimulationSink)(into, state; path, primitive!, from, seed, _...)
    # 1. Pause: outside the lock — paused producer must not block others.
    !isnothing(sink.controller) && check_pause!(sink.controller)

    # 2. Mutate under lock; capture any outbound messages to emit.
    messages = lock(sink.lock) do
        _process_segment!(sink, into, state; path, primitive!, from, seed)
    end

    # 3. WS send: outside the lock — a slow client cannot stall producers.
    if !isnothing(messages) && !isnothing(sink.controller)
        for msg in messages
            send!(sink.controller, msg)
        end
    end

    # Cooperative yield: let other branches advance when they outnumber threads.
    yield()
    return
end

# ============================================================================
# Locked processing
# ============================================================================

function _process_segment!(sink::StreamingSimulationSink, into, state;
                           path, primitive!, from, seed)
    to    = Models.t(state)
    model = primitive!.path
    label = haskey(primitive!.bindings, :label) ? primitive!.bindings[:label] : ""
    key   = (path, Float64(from))

    # Activate the segment we're about to record events for.
    if haskey(sink.progress.segments, key)
        push!(sink.progress.active, key)
        sp = sink.progress.segments[key]
        sp.high_water = max(sp.high_water, Float64(from))
    end

    sink.disk.next_episode_i += 1
    i = sink.disk.next_episode_i

    # Index-only episode (skip segments): no events to accumulate.
    if into === nothing
        push!(sink.disk.index,
              (; i, path, from = Float64(from), to, model, label, count = 0, into = "", seed))
        if from < to
            register_episode!(sink.stream.gap_tracker, path, Float64(from), to)
        end
        return _maybe_emit_payload(sink, to)
    end

    # Real episode with events.
    (species_in_episode, count) = _process_events!(sink, i, into, state, path, from)

    sink.disk.frame_count += 1

    _inject_synthetic_start!(sink, path, Float64(from))
    _inject_endpoint!(sink, path, Float64(from), to, species_in_episode)

    # Per-(species, path) prev_end update for next-segment gap detection.
    for sp in species_in_episode
        sink.stream.species_path_prev_end[(sp, path)] = to > 0.0 ? to : Float64(from)
    end

    # Index entry + gap tracker registration.
    push!(sink.disk.index,
          (; i, path, from = Float64(from), to, model, label, count, into, seed))
    register_episode!(sink.stream.gap_tracker, path, Float64(from), to)

    # Mark this segment done.
    if haskey(sink.progress.segments, key)
        _complete_segment!(sink.progress, key)
    end

    return _maybe_emit_payload(sink, to)
end

"""
Iterate events for this segment, pushing into the event buffer and pending
timeseries. Single fused pass — gap detection per subscribed species runs
once before events arrive; synthetic-start and endpoint injection run once
after, in `_inject_*!`.

Returns `(species_in_episode, count)`: the species set and the event count
for this segment (used for the index entry).
"""
function _process_events!(sink::StreamingSimulationSink, i::Int, into::String,
                          state, path::String, from)
    subscribed = isnothing(sink.controller) ? Set{Symbol}() : sink.controller.subscribed_species
    species_in_episode = Set{Symbol}()
    count = 0
    seg = get(sink.progress.segments, (path, Float64(from)), nothing)

    # Pre-event gap detection per subscribed species.
    _maybe_insert_gaps!(sink, subscribed, path, from)

    buf = _buffer(sink.disk, into)
    Models.each_event(state) do t::Float64, name::Symbol, value::Int64
        # Threshold flush keeps per-channel memory bounded across many segments.
        if length(buf) >= sink.disk.threshold
            _flush_buffer!(sink.disk, into)
            buf = _buffer(sink.disk, into)
        end
        push!(buf.is,     i)
        push!(buf.ts,     t)
        push!(buf.names,  name)
        push!(buf.values, value)
        count += 1

        if name in subscribed
            _push_pending!(sink.stream.pending, name, path, t, value)
            push!(species_in_episode, name)
        end

        !isnothing(seg) && t > seg.high_water && (seg.high_water = t)
    end

    return (species_in_episode, count)
end

@inline _buffer(disk::DiskState, into::String) =
    get!(EventBuffer, disk.buffers, into)

@inline function _push_pending!(pending::PendingTimeseries, name::Symbol,
                                path::String, t::Float64, value::Int64)
    species_dict = get!(() -> Dict{String, Vector{Tuple{Float64, Int}}}(), pending, name)
    series       = get!(() -> Tuple{Float64, Int}[], species_dict, path)
    push!(series, (t, value))
end

function _maybe_insert_gaps!(sink::StreamingSimulationSink, subscribed::Set{Symbol},
                             path::String, from)
    isempty(subscribed) && return
    for sp in subscribed
        prev_end = get(sink.stream.species_path_prev_end, (sp, path), NaN)
        (insert, t0, t1) = check_gap(sink.stream.gap_tracker, path, Float64(from), prev_end)
        insert || continue
        species_dict = get!(() -> Dict{String, Vector{Tuple{Float64, Int}}}(),
                            sink.stream.pending, sp)
        series = get!(() -> Tuple{Float64, Int}[], species_dict, path)
        if isempty(series) || series[end][2] != Int64(-1)
            push!(series, (t0, Int64(-1)))
            push!(series, (t1, Int64(-1)))
        end
    end
end

"""
For the first episode on a path, duplicate the first real point back to the
bridging run's start so the line visually begins at the segment boundary.
"""
function _inject_synthetic_start!(sink::StreamingSimulationSink, path::String, from::Float64)
    isnothing(sink.controller) && return
    for sp in sink.controller.subscribed_species
        prev_end = get(sink.stream.species_path_prev_end, (sp, path), NaN)
        (insert, start_t) = check_synthetic_start(sink.stream.gap_tracker, path, from, prev_end)
        insert || continue
        sd = get(sink.stream.pending, sp, nothing); isnothing(sd) && continue
        series = get(sd, path, nothing); (isnothing(series) || isempty(series)) && continue
        series[1][2] == Int64(-1) && continue
        pushfirst!(series, (start_t, series[1][2]))
    end
end

"""
Hold each species' last value out to the episode end time so the segment
renders to its full extent. Only species that actually fired in this segment.
"""
function _inject_endpoint!(sink::StreamingSimulationSink, path::String,
                           from::Float64, to::Float64, species::Set{Symbol})
    to > from || return
    for sp in species
        sd = get(sink.stream.pending, sp, nothing); isnothing(sd) && continue
        series = get(sd, path, nothing); (isnothing(series) || isempty(series)) && continue
        last_t, last_v = series[end]
        if last_v != Int64(-1) && last_t < to
            push!(series, (to, last_v))
        end
    end
end

# ============================================================================
# Streaming payload assembly
# ============================================================================

"""
Build WS messages to emit if the throttle has elapsed. Snapshots `pending`
and clears it under the lock; the caller sends after releasing the lock.
Returns `nothing` if no payload should fire, else a Vector of message dicts.
"""
function _maybe_emit_payload(sink::StreamingSimulationSink, current_time::Float64)
    isnothing(sink.controller) && return nothing
    now = time_ns()
    now - sink.stream.last_stream_ns < sink.stream.stream_interval_ns && return nothing
    sink.stream.last_stream_ns = now

    sim_id = sink.controller.simulation_id
    msgs = Dict{String, Any}[]
    push!(msgs, Dict{String, Any}(
        "type"           => "progress",
        "simulation_id"  => sim_id,
        "current_time"   => current_time,
        "frame_count"    => sink.disk.frame_count,
        "total_progress" => _total_progress(sink.progress),
    ))

    if !isempty(sink.stream.pending)
        push!(msgs, Dict{String, Any}(
            "type"          => "timeseries",
            "simulation_id" => sim_id,
            "data"          => _serialise_pending(sink.stream.pending),
        ))
        empty!(sink.stream.pending)
    end
    return msgs
end

function _serialise_pending(pending::PendingTimeseries)
    out = Dict{String, Dict{String, Vector{Vector{Any}}}}()
    for (species, by_path) in pending
        sp = String(species)
        sub = Dict{String, Vector{Vector{Any}}}()
        for (path, points) in by_path
            sub[path] = [[t, v] for (t, v) in points]
        end
        out[sp] = sub
    end
    return out
end

# ============================================================================
# Disk flushing
# ============================================================================

"""
    flush!(sink)

Flush all buffered events and any pending timeseries. Marks any remaining
active segments as completed. Called once at the end of `run_simulation`,
after all branch tasks have returned.
"""
function flush!(sink::StreamingSimulationSink)
    msg = lock(sink.lock) do
        sink.disk.next_episode_i == 0 && return nothing
        @info "[StreamingSink] Flushing all channels"

        for key in collect(sink.progress.active)
            _complete_segment!(sink.progress, key)
        end

        for into in collect(keys(sink.disk.buffers))
            _flush_buffer!(sink.disk, into)
        end
        _write_index!(sink.disk)

        isempty(sink.stream.pending) && return nothing
        sim_id = isnothing(sink.controller) ? "" : sink.controller.simulation_id
        out = Dict{String, Any}(
            "type"          => "timeseries",
            "simulation_id" => sim_id,
            "data"          => _serialise_pending(sink.stream.pending),
        )
        empty!(sink.stream.pending)
        out
    end

    !isnothing(msg) && !isnothing(sink.controller) && send!(sink.controller, msg)
    return
end

function _flush_buffer!(disk::DiskState, into::String)
    buf = pop!(disk.buffers, into)
    filename = joinpath(disk.location, "events$into.stream.arrow")
    @info "[StreamingSink] Flushing buffer" into=into events=length(buf.ts)

    events = (; i = buf.is, t = buf.ts, name = buf.names, value = buf.values)
    if isfile(filename)
        Arrow.append(filename, events)
    else
        Arrow.write(filename, events, file = false)
    end
    _write_index!(disk)
end

function _write_index!(disk::DiskState)
    isempty(disk.index) && return
    cols = Tables.columntable(disk.index)
    index_file = joinpath(disk.location, "index.arrow")
    Arrow.write(index_file, (;
        cols.i,
        cols.path,
        cols.from,
        cols.to,
        model = Arrow.DictEncode(cols.model),
        label = Arrow.DictEncode(cols.label),
        cols.count,
        into  = Arrow.DictEncode(cols.into),
        cols.seed,
    ))
    @debug "[StreamingSink] Wrote index" file=index_file episodes=length(disk.index)
end

end # module StreamingSink
