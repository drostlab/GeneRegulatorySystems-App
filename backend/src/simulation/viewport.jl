"""
    Viewport

Multi-resolution (pyramid) decimation of reconstructed step-function trajectories
for screen-resolution viewport queries.

SSA / ODE trajectories are piecewise-constant, right-continuous step functions
(`stairs!(…, step=:post)` in the canonical InspectTool reconstruction). Shipping
them at full resolution clogs the client renderer, so this module bins each
`(species, path)` series into an OHLC-style time pyramid and answers viewport
queries (`t0`, `t1`, `width_px`) with `≲ 2·width_px` points — independent of total
simulation length. Promoter activity uses time-weighted screen bins instead of
OHLC extrema so short pulses do not become artificially long active periods.

The pyramid sits *on top of* the canonical catenation reconstruction
(`Simulation.load_timeseries_for_species`): its input is already gap-marked
(`value == GAP` sentinel) and endpoint-injected. This module only decimates, and
never across `(species, path)` — replicates and branches stay separate series
(averaging would destroy stochasticity).
"""
module Viewport

import ..Simulation

export PathPyramid, build_pyramid, query, query_activity, query_species, GAP

"""Gap sentinel value carried by the reconstructed series (see GapTracking)."""
const GAP = -1

"""Number of binned levels above raw. Level `k` (1-based) has width `base_dt·2^(k-1)`."""
const N_LEVELS = 16

"""Horizontal pixels represented by one coarse promoter-activity bin."""
const ACTIVITY_PIXELS_PER_BIN = 4

"""Horizontal pixels represented by one count (OHLC) bin when decimating."""
const COUNT_PIXELS_PER_BIN = 4

# ============================================================================
# OHLC bin
# ============================================================================

"""
    Bin

One time-bin summary of a step series, addressed by integer `idx` at its level.
Representative samples retain their original time and sequence number. This is
essential for digital lines: moving a later minimum to the bin's left edge creates
a false vertical drop at boundaries that happen to align with the bin grid.
"""
struct Sample
    seq::Int
    time::Float64
    value::Int
end

const NO_SAMPLE = Sample(0, 0.0, 0)

struct Bin
    idx::Int
    first::Sample
    lo::Sample
    hi::Sample
    last::Sample
    first_gap::Sample
    last_gap::Sample
end

has_data(b::Bin) = b.first.seq != 0
has_gap(b::Bin) = b.first_gap.seq != 0

earlier(a::Sample, b::Sample) = a.seq <= b.seq ? a : b
later(a::Sample, b::Sample) = a.seq >= b.seq ? a : b
lower(a::Sample, b::Sample) = a.value <= b.value ? a : b
higher(a::Sample, b::Sample) = a.value >= b.value ? a : b

"""Merge two adjacent same-level bins into `parent` (cheap coarsening, no rescan)."""
function combine(l::Bin, r::Bin, parent::Int)::Bin
    first_sample = has_data(l) ? l.first : r.first
    last_sample = has_data(r) ? r.last : l.last
    lo = !has_data(l) ? r.lo : !has_data(r) ? l.lo : lower(l.lo, r.lo)
    hi = !has_data(l) ? r.hi : !has_data(r) ? l.hi : higher(l.hi, r.hi)
    first_gap = !has_gap(l) ? r.first_gap : !has_gap(r) ? l.first_gap : earlier(l.first_gap, r.first_gap)
    last_gap = !has_gap(r) ? l.last_gap : !has_gap(l) ? r.last_gap : later(l.last_gap, r.last_gap)
    Bin(
        parent,
        first_sample,
        lo,
        hi,
        last_sample,
        first_gap,
        last_gap,
    )
end

reindex(b::Bin, idx::Int) = Bin(idx, b.first, b.lo, b.hi, b.last, b.first_gap, b.last_gap)

# ============================================================================
# Per-(species, path) pyramid
# ============================================================================

"""
    PathPyramid

Multi-resolution view of a single reconstructed series. `raw` is the canonical
reconstruction (the thin level-0 wrapper, used verbatim when a query zooms past the
finest binned level); `levels[k]` holds the sorted occupied bins at width
`base_dt·2^(k-1)`, each built by merging the level below.
"""
struct PathPyramid
    raw::Vector{Tuple{Float64, Int}}
    t0::Float64
    base_dt::Float64
    levels::Vector{Vector{Bin}}
    times::Vector{Float64}
    cumulative_area::Vector{Float64}
    cumulative_covered::Vector{Float64}
end

level_dt(p::PathPyramid, k::Int) = p.base_dt * 2.0^(k - 1)

"""
    build_pyramid(raw; activity=false) -> PathPyramid

Build the full pyramid for one reconstructed `(time, value)` series. `GAP` points
are discontinuity markers, excluded from `lo`/`hi`. Activity pyramids retain
prefix integrals instead of OHLC levels because promoter queries only need
time-weighted screen-bin averages.
"""
function build_pyramid(
    raw::Vector{Tuple{Float64, Int}}; activity::Bool = false,
)::PathPyramid
    isempty(raw) && return PathPyramid(
        raw, 0.0, 1.0, [Bin[] for _ in 1:N_LEVELS], Float64[], Float64[], Float64[],
    )

    t0 = first(first(raw))
    span = first(last(raw)) - t0
    base_dt = span > 0 ? span / (2.0^N_LEVELS) : 1.0

    levels = [Bin[] for _ in 1:N_LEVELS]
    if !activity
        levels[1] = bin_raw(raw, t0, base_dt)
        for k in 2:N_LEVELS
            levels[k] = coarsen(levels[k - 1])
        end
    end
    times, cumulative_area, cumulative_covered = activity ? build_integrals(raw) :
        (Float64[], Float64[], Float64[])
    return PathPyramid(raw, t0, base_dt, levels, times, cumulative_area, cumulative_covered)
end

"""Prefix integrals of value and non-gap duration for fast activity averages."""
function build_integrals(raw::Vector{Tuple{Float64, Int}})
    n = length(raw)
    times = first.(raw)
    area = zeros(Float64, n)
    covered = zeros(Float64, n)
    for i in 2:n
        dt = max(0.0, times[i] - times[i - 1])
        value = raw[i - 1][2]
        area[i] = area[i - 1]
        covered[i] = covered[i - 1]
        if value != GAP
            area[i] += value * dt
            covered[i] += dt
        end
    end
    return times, area, covered
end

"""Bin the raw series into the finest level in a single pass."""
function bin_raw(raw::Vector{Tuple{Float64, Int}}, t0::Float64, dt::Float64)::Vector{Bin}
    bins = Bin[]
    cur = 0
    first_sample = lo = hi = last_sample = NO_SAMPLE
    first_gap = last_gap = NO_SAMPLE

    function flush!()
        (first_sample.seq != 0 || first_gap.seq != 0) || return
        push!(bins, Bin(cur, first_sample, lo, hi, last_sample, first_gap, last_gap))
    end

    for (seq, (t, v)) in enumerate(raw)
        idx = floor(Int, (t - t0) / dt)
        if idx != cur || (first_sample.seq == 0 && first_gap.seq == 0)
            (first_sample.seq != 0 || first_gap.seq != 0) && flush!()
            cur = idx
            first_sample = lo = hi = last_sample = NO_SAMPLE
            first_gap = last_gap = NO_SAMPLE
        end
        sample = Sample(seq, t, v)
        if v == GAP
            first_gap.seq == 0 && (first_gap = sample)
            last_gap = sample
        else
            if first_sample.seq == 0
                first_sample = lo = hi = sample
            else
                lo = lower(lo, sample)
                hi = higher(hi, sample)
            end
            last_sample = sample
        end
    end
    flush!()
    return bins
end

"""Coarsen a level by merging bin pairs that share a parent cell (`parent = idx >> 1`)."""
function coarsen(fine::Vector{Bin})::Vector{Bin}
    coarse = Bin[]
    sizehint!(coarse, cld(length(fine), 2))
    for b in fine
        parent = b.idx >> 1
        if !isempty(coarse) && last(coarse).idx == parent
            coarse[end] = combine(coarse[end], b, parent)
        else
            push!(coarse, reindex(b, parent))
        end
    end
    return coarse
end

# ============================================================================
# Viewport query
# ============================================================================

"""
    query(p, t0, t1, width_px) -> Vector{Tuple{Float64, Int}}

Decimated step series for `[t0, t1]` holding `≲ 2·width_px` points. Picks the
coarsest pyramid level still finer than one screen pixel; zoomed past the finest
level, returns the raw slice. Output keeps the reconstruction's contract — a
`(time, value)` step series with `GAP` sentinels, ready to render as `step=:post`.
"""
function query(p::PathPyramid, t0::Float64, t1::Float64, width_px::Int)::Vector{Tuple{Float64, Int}}
    isempty(p.raw) && return Tuple{Float64, Int}[]
    width_px = max(width_px, 1)
    target_dt = (t1 - t0) / width_px

    target_dt <= p.base_dt && return raw_slice(p.raw, t0, t1)

    # Pick a level whose bin width ≥ COUNT_PIXELS_PER_BIN·target_dt, so the window
    # spans ≤ width_px/COUNT_PIXELS_PER_BIN bins. Each bin emits ≤4 OHLC points.
    k = clamp(ceil(Int, log2(COUNT_PIXELS_PER_BIN * target_dt / p.base_dt)) + 1, 1, N_LEVELS)
    return expand(p, k, t0, t1)
end

"""Integral of promoter value and represented duration up to time `t`."""
function activity_integral_at(p::PathPyramid, t::Float64)::Tuple{Float64, Float64}
    isempty(p.raw) && return (0.0, 0.0)
    bounded = clamp(t, first(p.times), last(p.times))
    i = searchsortedlast(p.times, bounded)
    i == 0 && return (0.0, 0.0)
    area = p.cumulative_area[i]
    covered = p.cumulative_covered[i]
    value = p.raw[i][2]
    if value != GAP
        dt = bounded - p.times[i]
        area += value * dt
        covered += dt
    end
    return area, covered
end

"""
    query_activity(p, t0, t1, width_px)

Return exact promoter transitions when they fit the screen budget. Otherwise,
return one time-weighted activity value per `ACTIVITY_PIXELS_PER_BIN` horizontal
pixels. Fractional values are rendered through promoter-band opacity by the client.
"""
function query_activity(
    p::PathPyramid, t0::Float64, t1::Float64, width_px::Int,
)::Vector{Tuple{Float64, Float64}}
    (isempty(p.raw) || t1 <= t0) && return Tuple{Float64, Float64}[]
    isempty(p.times) && throw(ArgumentError("activity query requires an activity pyramid"))
    width_px = max(width_px, 1)
    bin_count = max(1, cld(width_px, ACTIVITY_PIXELS_PER_BIN))
    exact = raw_slice(p.raw, t0, t1)
    if length(exact) <= bin_count
        return [(t, Float64(value)) for (t, value) in exact]
    end

    dt = (t1 - t0) / bin_count
    out = Tuple{Float64, Float64}[]
    sizehint!(out, bin_count + 1)
    last_value = Float64(GAP)
    for i in 0:bin_count-1
        left = t0 + i * dt
        right = i == bin_count - 1 ? t1 : left + dt
        left_area, left_covered = activity_integral_at(p, left)
        right_area, right_covered = activity_integral_at(p, right)
        covered = right_covered - left_covered
        value = covered > 0 ? (right_area - left_area) / covered : Float64(GAP)
        push!(out, (left, value))
        last_value = value
    end
    push!(out, (t1, last_value))
    return out
end

"""Raw points within `[t0, t1]`, plus one straddling point each side for clean step edges."""
function raw_slice(raw::Vector{Tuple{Float64, Int}}, t0::Float64, t1::Float64)::Vector{Tuple{Float64, Int}}
    lo = searchsortedlast(raw, (t0, 0); by = first)   # last point at or before t0
    hi = searchsortedfirst(raw, (t1, 0); by = first)  # first point at or after t1
    lo = max(lo, 1)
    hi = min(hi, length(raw))
    return raw[lo:hi]
end

"""Expand the bins of level `k` overlapping `[t0, t1]` into an OHLC step point series."""
function expand(p::PathPyramid, k::Int, t0::Float64, t1::Float64)::Vector{Tuple{Float64, Int}}
    bins = p.levels[k]
    dt = level_dt(p, k)
    i0 = floor(Int, (t0 - p.t0) / dt)
    i1 = floor(Int, (t1 - p.t0) / dt)
    lo = searchsortedfirst(bins, i0; by = idx_of)
    out = Tuple{Float64, Int}[]
    i = lo
    n = length(bins)
    while i <= n && bins[i].idx <= i1 + 1
        emit_bin!(out, bins[i])
        i += 1
    end
    # Carry-in: include the bin just before the window so the entering step is correct.
    if lo > 1
        prepend_bin!(out, bins[lo - 1])
    end
    return out
end

idx_of(b::Bin) = b.idx
idx_of(i::Int) = i

"""Append a bin's representative points at their original times and in source order."""
function emit_bin!(out::Vector{Tuple{Float64, Int}}, b::Bin)
    samples = Sample[b.first, b.lo, b.hi, b.last, b.first_gap, b.last_gap]
    filter!(sample -> sample.seq != 0, samples)
    sort!(samples; by = sample -> sample.seq)

    previous_seq = 0
    for sample in samples
        sample.seq == previous_seq && continue
        push!(out, (sample.time, sample.value))
        previous_seq = sample.seq
    end
    return
end

function prepend_bin!(out::Vector{Tuple{Float64, Int}}, b::Bin)
    pre = Tuple{Float64, Int}[]
    emit_bin!(pre, b)
    prepend!(out, pre)
    return
end

# ============================================================================
# Per-result pyramid cache (lazy, in-memory, keyed by result path)
# ============================================================================

"""All pyramids of one result: species → path → PathPyramid, plus a freshness stamp."""
struct ResultPyramids
    stamp::UInt64
    by_species::Dict{Symbol, Dict{String, PathPyramid}}
end

const CACHE = Dict{String, ResultPyramids}()
const CACHE_LOCK = ReentrantLock()

"""Freshness stamp over a result's event files — invalidates the cache as a live run grows."""
function event_stamp(result_path::String)::UInt64
    h = UInt64(0)
    isdir(result_path) || return h
    for f in readdir(result_path; join = true)
        (startswith(basename(f), "events") && endswith(f, ".stream.arrow")) || continue
        st = stat(f)
        h = hash((basename(f), st.size, st.mtime), h)
    end
    return h
end

"""Build every (species, path) pyramid for a result in a single events scan."""
function build_result_pyramids(result_path::String, stamp::UInt64)::ResultPyramids
    load_t = @elapsed ts = Simulation.load_timeseries_for_species(result_path, nothing)
    by_species = Dict{Symbol, Dict{String, PathPyramid}}()
    build_t = @elapsed for (species, path_series) in ts
        activity = endswith(String(species), ".active")
        by_species[species] = Dict{String, PathPyramid}(
            path => build_pyramid(series; activity) for (path, series) in path_series
        )
    end
    n_paths = sum(length(v) for v in values(by_species); init = 0)
    @info "Viewport pyramids built" result=basename(result_path) n_species=length(by_species) n_paths load_ms=round(load_t * 1e3; digits = 1) build_ms=round(build_t * 1e3; digits = 1)
    return ResultPyramids(stamp, by_species)
end

"""
    result_pyramids(result_path) -> ResultPyramids

All pyramids for a result, served from the in-memory cache or a fresh single-scan
build. One events scan covers every species, so a multi-species viewport load pays
the scan once rather than once per series. Also the pre-warm entry point: called at
run completion so the first post-run load lands on a warm cache.
"""
function result_pyramids(result_path::String)::ResultPyramids
    stamp = event_stamp(result_path)
    lock(CACHE_LOCK) do
        hit = get(CACHE, result_path, nothing)
        hit !== nothing && hit.stamp == stamp && return hit

        entry = build_result_pyramids(result_path, stamp)
        CACHE[result_path] = entry
        return entry
    end
end

"""Pyramids for one species of a result (empty if the species has no data)."""
function species_pyramids(result_path::String, species::Symbol)::Dict{String, PathPyramid}
    get(result_pyramids(result_path).by_species, species, Dict{String, PathPyramid}())
end

"""Drop cached pyramids for a result (e.g. on delete)."""
function invalidate!(result_path::String)
    lock(CACHE_LOCK) do
        delete!(CACHE, result_path)
    end
end

"""
    query_species(result_path, species, path, t0, t1, width_px) -> Vector{Tuple{Float64, Int}}

Top-level viewport query: decimated step series for one `(species, path)` over
`[t0, t1]`, building/caching the pyramid lazily. Returns `nothing` if the path has
no data for that species.
"""
function query_species(
    result_path::String, species::Symbol, path::String,
    t0::Float64, t1::Float64, width_px::Int,
)::Union{Vector{Tuple{Float64, Int}}, Nothing}
    paths = species_pyramids(result_path, species)
    p = get(paths, path, nothing)
    p === nothing && return nothing
    return query(p, t0, t1, width_px)
end

"""Viewport query using time-weighted promoter occupancy at coarse resolution."""
function query_activity_species(
    result_path::String, species::Symbol, path::String,
    t0::Float64, t1::Float64, width_px::Int,
)::Union{Vector{Tuple{Float64, Float64}}, Nothing}
    paths = species_pyramids(result_path, species)
    p = get(paths, path, nothing)
    p === nothing && return nothing
    return query_activity(p, t0, t1, width_px)
end

"""List the execution paths available for `species` in a result (for the path-filter UI)."""
function paths_for(result_path::String, species::Symbol)::Vector{String}
    collect(keys(species_pyramids(result_path, species)))
end

end # module Viewport
