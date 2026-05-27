"""
    TimeseriesSummary

Compute mean and standard error of timeseries across execution paths.

Two strategies:
- **Step-based schedules**: all paths share the same snapshot time grid.
  Direct averaging at each time point, no interpolation needed.
- **Continuous schedules**: paths have irregular event-driven times.
  Build a uniform time grid via linear spacing, then use step-function
  interpolation (`step_value`) to evaluate each path at each grid point.

The caller does not choose the strategy; it is auto-detected from the
index.arrow episode metadata.
"""
module TimeseriesSummary

using Arrow
using Statistics

import ..Simulation: load_timeseries_for_species, get_result_path

# ============================================================================
# Public API
# ============================================================================

"""
    SpeciesSummary

Mean and standard error for a single species across paths.
"""
struct SpeciesSummary
    time::Vector{Float64}
    mean::Vector{Float64}
    se::Vector{Float64}
end

"""
    compute_summary(result_path, species_filter; n_points=500) -> Dict{Symbol, SpeciesSummary}

Compute mean + SE for each requested species across all execution paths.

Auto-detects whether the schedule uses step-based snapshots (shared grid)
or continuous recording (irregular times), and picks the appropriate strategy.
"""
function compute_summary(
    result_path::String,
    species_filter::Set{Symbol};
    n_points::Int = 500
)::Dict{Symbol, SpeciesSummary}
    timeseries = load_timeseries_for_species(result_path, species_filter)
    isempty(timeseries) && return Dict{Symbol, SpeciesSummary}()

    grid = detect_shared_grid(timeseries)
    if !isnothing(grid)
        @debug "TimeseriesSummary: using shared grid" n_points=length(grid)
        return summarise_on_shared_grid(timeseries, grid)
    else
        @debug "TimeseriesSummary: using uniform interpolation grid" n_points
        return summarise_on_uniform_grid(timeseries, n_points)
    end
end

# ============================================================================
# Strategy 1: Shared time grid (step-based schedules)
# ============================================================================

"""
Detect whether all paths for all species share the same time grid.
Returns the grid if so, `nothing` otherwise.
"""
function detect_shared_grid(
    timeseries::Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}}
)::Union{Nothing, Vector{Float64}}
    reference_grid::Union{Nothing, Vector{Float64}} = nothing

    for path_map in values(timeseries)
        for series in values(path_map)
            times = extract_times(series)
            isempty(times) && continue
            if isnothing(reference_grid)
                reference_grid = times
            elseif times != reference_grid
                return nothing
            end
        end
    end
    return reference_grid
end

"""Extract sorted unique time points from a series, excluding gap markers (-1)."""
function extract_times(series::Vector{Tuple{Float64, Int}})::Vector{Float64}
    times = Float64[]
    for (t, state) in series
        if state != -1
            push!(times, t)
        end
    end
    return unique!(sort!(times))
end

"""Compute mean + SE at each shared grid point."""
function summarise_on_shared_grid(
    timeseries::Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}},
    grid::Vector{Float64}
)::Dict{Symbol, SpeciesSummary}
    result = Dict{Symbol, SpeciesSummary}()
    n_t = length(grid)

    for (species, path_map) in timeseries
        paths = collect(values(path_map))
        n_paths = length(paths)
        n_paths == 0 && continue

        mean_vals = zeros(Float64, n_t)
        se_vals = zeros(Float64, n_t)

        if n_paths == 1
            # Single path: mean = values, SE = 0
            for (i, t) in enumerate(grid)
                mean_vals[i] = Float64(step_value(paths[1], t))
            end
        else
            # Multiple paths: accumulate values per time point
            vals = zeros(Float64, n_paths)
            for (i, t) in enumerate(grid)
                for (j, series) in enumerate(paths)
                    vals[j] = Float64(step_value(series, t))
                end
                mean_vals[i] = mean(vals)
                se_vals[i] = std(vals) / sqrt(n_paths)
            end
        end

        result[species] = SpeciesSummary(grid, mean_vals, se_vals)
    end

    return result
end

# ============================================================================
# Strategy 2: Uniform interpolation grid (continuous schedules)
# ============================================================================

"""Build a uniform grid across the full time range and interpolate."""
function summarise_on_uniform_grid(
    timeseries::Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}},
    n_points::Int
)::Dict{Symbol, SpeciesSummary}
    # Find global time range
    t_min = Inf
    t_max = -Inf
    for path_map in values(timeseries)
        for series in values(path_map)
            for (t, state) in series
                state == -1 && continue
                t_min = min(t_min, t)
                t_max = max(t_max, t)
            end
        end
    end
    (isinf(t_min) || t_min >= t_max) && return Dict{Symbol, SpeciesSummary}()

    grid = collect(range(t_min, t_max; length=n_points))
    return summarise_on_shared_grid(timeseries, grid)
end

# ============================================================================
# Step-function lookup (same logic as phase_space.jl)
# ============================================================================

"""Last recorded value at or before `t` (step-function lookup)."""
function step_value(ts::Vector{Tuple{Float64, Int}}, t::Float64)::Int
    isempty(ts) && return 0
    idx = searchsortedlast(ts, (t, typemax(Int)); by = first)
    idx == 0 ? 0 : ts[idx][2]
end

end # module
