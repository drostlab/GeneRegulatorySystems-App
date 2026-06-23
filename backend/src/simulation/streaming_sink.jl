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
    ProgressSegment

One scheduled segment on the execution-ordered progress timeline.

- `from`/`to`: absolute simulation-time range of the segment
- `duration`: `to - from` (precomputed)
"""
@kwdef struct ProgressSegment
    from::Float64
    to::Float64
    duration::Float64
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
- `progress_segments::Vector{ProgressSegment}`: Scheduled segments in execution order
- `progress_prefix::Vector{Float64}`: Cumulative duration *before* each segment (prefix sum)
- `total_duration::Float64`: Sum of all segment durations (denominator for total progress)
- `committed_duration::Float64`: Scheduled duration executed so far, accumulated per traced segment
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
    progress_segments::Vector{ProgressSegment} = ProgressSegment[]
    progress_prefix::Vector{Float64} = Float64[]
    total_duration::Float64 = 0.0
    committed_duration::Float64 = 0.0
end

"""
    set_segments!(sink, segments)

Initialise progress tracking from the schedule's execution-ordered timeline
segments. Each segment is a NamedTuple or struct with `from`/`to`. The segments
are collected by a dryrun in execution order, so progress can be located by
cumulative scheduled duration — robust to branch time-resets (where a later
branch restarts at an earlier absolute time) and to contiguous-segment merging.
"""
function set_segments!(sink::StreamingSimulationSink, segments)
    empty!(sink.progress_segments)
    empty!(sink.progress_prefix)
    sink.committed_duration = 0.0
    acc = 0.0
    for seg in segments
        dur = max(seg.to - seg.from, 0.0)
        push!(sink.progress_segments, ProgressSegment(from=seg.from, to=seg.to, duration=dur))
        push!(sink.progress_prefix, acc)
        acc += dur
    end
    sink.total_duration = acc
    @debug "[StreamingSink] Progress segments initialised" n_segments=length(segments) total_duration=sink.total_duration
end

"""
    compute_total_progress(sink, current_time) -> Float64

Compute overall simulation progress (0.0–1.0).

`committed_duration` is the scheduled duration of all fully traced segments, so
it locates the currently executing segment on the execution-ordered timeline
(by cumulative duration, not absolute time). `current_time` — the integrator
time from a mid-segment `consolidated_progress` tick, or a segment's end time at
a trace boundary — then adds smooth intra-segment progress on top.
"""
function compute_total_progress(sink::StreamingSimulationSink, current_time::Float64)::Float64
    sink.total_duration <= 0.0 && return 0.0
    elapsed = sink.committed_duration

    if !isempty(sink.progress_segments)
        # The active segment is the last one whose prefix does not exceed what
        # has been committed so far. Locate by committed (execution-order) duration
        # rather than absolute time -- parallel branches reuse the same absolute
        # time range, so a time-based scan would over-count sibling branches.
        k = clamp(searchsortedlast(sink.progress_prefix, elapsed + 1e-9),
                  1, length(sink.progress_segments))
        seg = sink.progress_segments[k]
        already = clamp(elapsed - sink.progress_prefix[k], 0.0, seg.duration)
        intra = clamp(current_time - seg.from, 0.0, seg.duration)
        elapsed = sink.progress_prefix[k] + max(already, intra)
    end

    return clamp(elapsed / sink.total_duration, 0.0, 1.0)
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

    sink.i += 1
    to = Models.t(state)

    # Account this segment's scheduled duration towards overall progress. Trace
    # callbacks fire in execution order, one per primitive, so this advances the
    # progress front through the timeline (raw segments, not the merged ones used
    # for the denominator — but both sum to the same total duration).
    sink.committed_duration += max(to - Float64(from), 0.0)
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
