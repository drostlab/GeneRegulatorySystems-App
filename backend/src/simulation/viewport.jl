"""
    Viewport

Multi-resolution (pyramid) decimation of reconstructed step-function trajectories
for screen-resolution viewport queries.

SSA / ODE trajectories are piecewise-constant, right-continuous step functions
(`stairs!(…, step=:post)` in the canonical InspectTool reconstruction). Shipping
them at full resolution clogs the client renderer, so this module bins each
`(species, path)` series into an OHLC-style time pyramid and answers viewport
queries (`t0`, `t1`, `width_px`) with `≲ 2·width_px` points — independent of total
simulation length.

The pyramid sits *on top of* the canonical catenation reconstruction
(`Simulation.load_timeseries_for_species`): its input is already gap-marked
(`value == GAP` sentinel) and endpoint-injected. This module only decimates, and
never across `(species, path)` — replicates and branches stay separate series
(averaging would destroy stochasticity).
"""
module Viewport

import ..Simulation

export PathPyramid, build_pyramid, query, query_species, GAP

"""Gap sentinel value carried by the reconstructed series (see GapTracking)."""
const GAP = -1

"""Number of binned levels above raw. Level `k` (1-based) has width `base_dt·2^(k-1)`."""
const N_LEVELS = 16

# ============================================================================
# OHLC bin
# ============================================================================

"""
    Bin

One time-bin summary of a step series, addressed by integer `idx` at its level
(left edge = `t0 + idx·dt`). `lo`/`hi` capture within-bin spikes that a single
value per bin would drop; `first`/`last` give entry/exit values so a step trace
connects to neighbouring bins. `gap` marks a bin containing a discontinuity so the
renderer breaks the line rather than carrying across it.

A pure-gap bin (no real samples) has `lo > hi` and renders as a single gap point.
"""
struct Bin
    idx::Int
    first::Int
    lo::Int
    hi::Int
    last::Int
    gap::Bool
end

has_data(b::Bin) = b.lo <= b.hi

"""Merge two adjacent same-level bins into `parent` (cheap coarsening, no rescan)."""
function combine(l::Bin, r::Bin, parent::Int)::Bin
    Bin(
        parent,
        has_data(l) ? l.first : r.first,
        min(l.lo, r.lo),
        max(l.hi, r.hi),
        has_data(r) ? r.last : l.last,
        l.gap | r.gap,
    )
end

reindex(b::Bin, idx::Int) = Bin(idx, b.first, b.lo, b.hi, b.last, b.gap)

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
end

level_dt(p::PathPyramid, k::Int) = p.base_dt * 2.0^(k - 1)
bin_time(p::PathPyramid, k::Int, idx::Int) = p.t0 + idx * level_dt(p, k)

"""
    build_pyramid(raw) -> PathPyramid

Build the full pyramid for one reconstructed `(time, value)` series. `GAP` points
are discontinuity markers, excluded from `lo`/`hi`.
"""
function build_pyramid(raw::Vector{Tuple{Float64, Int}})::PathPyramid
    isempty(raw) && return PathPyramid(raw, 0.0, 1.0, [Bin[] for _ in 1:N_LEVELS])

    t0 = first(first(raw))
    span = first(last(raw)) - t0
    base_dt = span > 0 ? span / (2.0^N_LEVELS) : 1.0

    levels = Vector{Vector{Bin}}(undef, N_LEVELS)
    levels[1] = bin_raw(raw, t0, base_dt)
    for k in 2:N_LEVELS
        levels[k] = coarsen(levels[k - 1])
    end
    return PathPyramid(raw, t0, base_dt, levels)
end

"""Bin the raw series into the finest level in a single pass."""
function bin_raw(raw::Vector{Tuple{Float64, Int}}, t0::Float64, dt::Float64)::Vector{Bin}
    bins = Bin[]
    cur = 0
    first_v = lo = hi = last_v = 0
    real = false
    gap = false

    function flush!()
        (real || gap) || return
        push!(bins, Bin(cur, first_v, real ? lo : 1, real ? hi : 0, last_v, gap))
    end

    for (t, v) in raw
        idx = floor(Int, (t - t0) / dt)
        if idx != cur || (!real && !gap)
            (real || gap) && flush!()
            cur, real, gap = idx, false, false
            lo, hi = typemax(Int), typemin(Int)
        end
        if v == GAP
            gap = true
        else
            real || (first_v = v)
            real = true
            lo, hi = min(lo, v), max(hi, v)
            last_v = v
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

    # Pick a level whose bin width ≥ 2·target_dt, so the window spans ≤ width_px/2
    # bins. Each bin emits ≤4 OHLC points, keeping output ≤ ~2·width_px.
    k = clamp(ceil(Int, log2(target_dt / p.base_dt)) + 2, 1, N_LEVELS)
    return expand(p, k, t0, t1)
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
        emit_bin!(out, bins[i], bin_time(p, k, bins[i].idx))
        i += 1
    end
    # Carry-in: include the bin just before the window so the entering step is correct.
    if lo > 1
        prepend_bin!(out, bins[lo - 1], bin_time(p, k, bins[lo - 1].idx))
    end
    return out
end

idx_of(b::Bin) = b.idx
idx_of(i::Int) = i

"""Append a bin's OHLC envelope as step points at its left edge `t` (deduping flats)."""
function emit_bin!(out::Vector{Tuple{Float64, Int}}, b::Bin, t::Float64)
    if !has_data(b)
        push!(out, (t, GAP))
        return
    end
    for v in (b.first, b.lo, b.hi, b.last)
        (isempty(out) || last(out)[2] != v || last(out)[1] != t) && push!(out, (t, v))
    end
    b.gap && push!(out, (t, GAP))
    return
end

function prepend_bin!(out::Vector{Tuple{Float64, Int}}, b::Bin, t::Float64)
    pre = Tuple{Float64, Int}[]
    emit_bin!(pre, b, t)
    prepend!(out, pre)
    return
end

# ============================================================================
# Per-species pyramid cache (lazy, keyed by result + species)
# ============================================================================

"""Cached pyramids for one species of one result: path → PathPyramid, plus a freshness stamp."""
struct SpeciesPyramids
    stamp::UInt64
    paths::Dict{String, PathPyramid}
end

const CACHE = Dict{Tuple{String, Symbol}, SpeciesPyramids}()
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

"""Build (or fetch cached) pyramids for every path of `species` in a result."""
function species_pyramids(result_path::String, species::Symbol)::Dict{String, PathPyramid}
    stamp = event_stamp(result_path)
    key = (result_path, species)
    lock(CACHE_LOCK) do
        hit = get(CACHE, key, nothing)
        hit !== nothing && hit.stamp == stamp && return hit.paths

        ts = Simulation.load_timeseries_for_species(result_path, Set((species,)))
        path_series = get(ts, species, Dict{String, Vector{Tuple{Float64, Int}}}())
        paths = Dict{String, PathPyramid}(
            path => build_pyramid(series) for (path, series) in path_series
        )
        CACHE[key] = SpeciesPyramids(stamp, paths)
        return paths
    end
end

"""Drop cached pyramids for a result (e.g. on delete)."""
function invalidate!(result_path::String)
    lock(CACHE_LOCK) do
        for k in collect(keys(CACHE))
            first(k) == result_path && delete!(CACHE, k)
        end
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

"""List the execution paths available for `species` in a result (for the path-filter UI)."""
function paths_for(result_path::String, species::Symbol)::Vector{String}
    collect(keys(species_pyramids(result_path, species)))
end

end # module Viewport
