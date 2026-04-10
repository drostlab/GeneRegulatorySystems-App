# ============================================================================
# Gap Tracking for Timeseries Continuity
# ============================================================================
#
# Shared gap-detection logic used by both real-time streaming (StreamingSink)
# and post-hoc Arrow loading (Simulation). Determines where to insert NaN gap
# markers and synthetic start-points for step-based schedules.
#
# The tracker owns the *decisions*; callers manage their own data insertion.

module GapTracking

export GapTracker, register_episode!, check_gap, check_synthetic_start

const GAP_EPSILON = 1e-9

"""
    GapTracker

Tracks episode intervals per execution path for gap detection.

For each non-instant episode `(from < to)` on a path, records
`run_predecessor[path][to] = from`. This lets snapshot episodes
(where `from == to`) look up the bridging run that feeds into them.
"""
@kwdef mutable struct GapTracker
    run_predecessor::Dict{String, Dict{Float64, Float64}} = Dict{String, Dict{Float64, Float64}}()
    last_to::Dict{String, Float64} = Dict{String, Float64}()
end

"""
    register_episode!(tracker, path, from, to)

Record a non-instant episode for predecessor lookup. Updates `last_to` for all episodes.
"""
function register_episode!(tracker::GapTracker, path::String, from::Float64, to::Float64)
    if from < to
        preds = get!(tracker.run_predecessor, path) do; Dict{Float64, Float64}() end
        preds[to] = from
    end
    tracker.last_to[path] = to
end

"""
    check_gap(tracker, path, ep_from, prev_end) -> (insert::Bool, gap_t::Float64)

Determine whether a gap marker should be inserted before this episode.

Returns `(true, gap_t)` if there is a discontinuity, `(false, NaN)` otherwise.
`gap_t` is placed at `prev_end + epsilon` so step-function rendering holds
just past the last real endpoint.
"""
function check_gap(tracker::GapTracker, path::String, ep_from::Float64, prev_end::Float64)::Tuple{Bool, Float64}
    isnan(prev_end) && return (false, NaN)
    run_pred = get(tracker.run_predecessor, path, Dict{Float64, Float64}())
    predecessor_from = get(run_pred, ep_from, NaN)
    gap_start = isnan(predecessor_from) ? ep_from : predecessor_from
    if gap_start > prev_end + GAP_EPSILON
        return (true, prev_end + GAP_EPSILON)
    end
    return (false, NaN)
end

"""
    check_synthetic_start(tracker, path, ep_from, prev_end) -> (insert::Bool, start_t::Float64)

Determine whether a synthetic start-point should be prepended for the first
episode on a path in step-based schedules. The start-point duplicates the first
real data value back to the bridging run's start time so the line visually
begins at the segment boundary.

Returns `(true, start_t)` if needed, `(false, NaN)` otherwise.
"""
function check_synthetic_start(tracker::GapTracker, path::String, ep_from::Float64, prev_end::Float64)::Tuple{Bool, Float64}
    !isnan(prev_end) && return (false, NaN)
    run_pred = get(tracker.run_predecessor, path, Dict{Float64, Float64}())
    predecessor_from = get(run_pred, ep_from, NaN)
    if !isnan(predecessor_from) && predecessor_from < ep_from - GAP_EPSILON
        return (true, predecessor_from)
    end
    return (false, NaN)
end

end # module GapTracking
