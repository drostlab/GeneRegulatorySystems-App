"""
    SimulationControl

Thread-safe lifecycle control and the in-process live trajectory tail for the
single running simulation.
"""
module SimulationControl

using Logging

export SimulationController, SimulationCancelled
export check_control!, is_paused, pause!, resume!, cancel!, finalize!, is_finalizing
export set_live_species!, enter_path!, record_live_event!, update_live_progress!
export live_snapshot, lineage_of

const DEFAULT_LIVE_WINDOW = 1800.0
const DEFAULT_MAX_POINTS_PER_SERIES = 2000
const MAX_LIVE_SPECIES = 128

"""Raised cooperatively at a trace boundary when a run is cancelled."""
struct SimulationCancelled <: Exception end

Base.showerror(io::IO, ::SimulationCancelled) = print(io, "simulation cancelled")

"""
    lineage_of(path)

Return the execution-path prefix through the last branching `/n` component.
This is the same branch identity used by GRS InspectTool: sequential `+` and
`-n` descent stays within a lineage, while entering a nested or sibling branch
changes it.
"""
function lineage_of(path::AbstractString)::String
    matched = match(r"^(?:.*/\d+)?", path)
    isnothing(matched) ? "" : String(matched.match)
end

const LivePoints = Vector{Tuple{Float64, Int64}}
const LiveSeries = Dict{Symbol, Dict{String, LivePoints}}

"""Mutable live state. Every field is protected by `lock`."""
@kwdef mutable struct LiveTail
    lock::ReentrantLock = ReentrantLock()
    active_lineage::String = ""
    active_path::String = ""
    current_time::Float64 = 0.0
    frame_count::Int = 0
    total_progress::Float64 = 0.0
    latest_values::Dict{Symbol, Int64} = Dict{Symbol, Int64}()
    selected_species::Set{Symbol} = Set{Symbol}()
    series::LiveSeries = LiveSeries()
    window::Float64 = DEFAULT_LIVE_WINDOW
    max_points_per_series::Int = DEFAULT_MAX_POINTS_PER_SERIES
end

"""Lifecycle controller shared by the simulation task and HTTP handlers."""
@kwdef mutable struct SimulationController
    paused::Bool = false
    cancelled::Bool = false
    finalizing::Bool = false
    pause_condition::Threads.Condition = Threads.Condition()
    result_path::String
    simulation_id::String
    live::LiveTail = LiveTail()
end

"""Block while paused and throw at a safe trace boundary when cancelled."""
function check_control!(ctrl::SimulationController)
    lock(ctrl.pause_condition) do
        while ctrl.paused && !ctrl.cancelled
            @info "[SimulationController] Simulation paused, waiting..." id=ctrl.simulation_id
            wait(ctrl.pause_condition)
        end
        ctrl.cancelled && throw(SimulationCancelled())
    end
    nothing
end

function pause!(ctrl::SimulationController)
    lock(ctrl.pause_condition) do
        ctrl.cancelled || (ctrl.paused = true)
    end
    @info "[SimulationController] Paused" id=ctrl.simulation_id
end

function resume!(ctrl::SimulationController)
    lock(ctrl.pause_condition) do
        ctrl.paused = false
        notify(ctrl.pause_condition)
    end
    @info "[SimulationController] Resumed" id=ctrl.simulation_id
end

function cancel!(ctrl::SimulationController)
    lock(ctrl.pause_condition) do
        ctrl.cancelled = true
        ctrl.paused = false
        notify(ctrl.pause_condition)
    end
    @info "[SimulationController] Cancellation requested" id=ctrl.simulation_id
end

is_paused(ctrl::SimulationController) = lock(ctrl.pause_condition) do
    ctrl.paused
end

"""Mark the controller as finalizing — the run has finished computing and is now
building the viewport pyramids, before its status flips to `completed`."""
finalize!(ctrl::SimulationController) = (ctrl.finalizing = true; nothing)

is_finalizing(ctrl::SimulationController) = ctrl.finalizing

function seed_species!(live::LiveTail, species::Symbol)
    value = get(live.latest_values, species, nothing)
    isnothing(value) && return
    path_series = get!(live.series, species) do
        Dict{String, LivePoints}()
    end
    points = get!(path_series, live.active_path) do
        LivePoints()
    end
    isempty(points) && push!(points, (live.current_time, value))
end

"""Replace the desired live species, seeding newly selected values at `now`."""
function set_live_species!(ctrl::SimulationController, species::Vector{String})
    length(species) <= MAX_LIVE_SPECIES || throw(ArgumentError(
        "at most $MAX_LIVE_SPECIES species can be monitored live"
    ))
    desired = Set(Symbol.(species))
    live = ctrl.live
    lock(live.lock) do
        for removed in setdiff(live.selected_species, desired)
            delete!(live.series, removed)
        end
        added = setdiff(desired, live.selected_species)
        live.selected_species = desired
        for name in added
            seed_species!(live, name)
        end
    end
    nothing
end

"""Set the current path, clearing live history only when its lineage changes."""
function enter_path!(ctrl::SimulationController, path::AbstractString, from::Float64)
    live = ctrl.live
    path_string = String(path)
    lineage = lineage_of(path_string)
    lock(live.lock) do
        if lineage != live.active_lineage
            empty!(live.series)
            empty!(live.latest_values)
            live.active_lineage = lineage
            live.current_time = from
        end
        live.active_path = path_string
    end
    nothing
end

function prune_points!(points::LivePoints, cutoff::Float64, maximum::Int)
    isempty(points) && return

    # Keep one value at the left edge so quiet sparse series remain visible.
    first_after = findfirst(point -> point[1] >= cutoff, points)
    if isnothing(first_after)
        last_value = points[end][2]
        empty!(points)
        push!(points, (cutoff, last_value))
    elseif first_after > 1
        baseline = points[first_after - 1][2]
        deleteat!(points, 1:first_after-1)
        points[1][1] > cutoff && pushfirst!(points, (cutoff, baseline))
    end

    if length(points) > maximum
        deleteat!(points, 1:length(points)-maximum)
    end
end

"""Record one raw event in the latest-value map and, if selected, its live tail."""
function record_live_event!(ctrl::SimulationController, path::AbstractString,
                            t::Float64, name::Symbol, value::Int64)
    live = ctrl.live
    lock(live.lock) do
        live.current_time = max(live.current_time, t)
        live.latest_values[name] = value
        name in live.selected_species || return
        path_series = get!(live.series, name) do
            Dict{String, LivePoints}()
        end
        points = get!(path_series, String(path)) do
            LivePoints()
        end
        push!(points, (t, value))
        prune_points!(points, live.current_time - live.window, live.max_points_per_series)
    end
    nothing
end

function update_live_progress!(ctrl::SimulationController, current_time::Float64,
                               frame_count::Int, total_progress::Float64)
    live = ctrl.live
    lock(live.lock) do
        live.current_time = max(live.current_time, current_time)
        live.frame_count = frame_count
        live.total_progress = total_progress
        cutoff = live.current_time - live.window
        for path_series in values(live.series), points in values(path_series)
            prune_points!(points, cutoff, live.max_points_per_series)
        end
    end
    nothing
end

"""
    live_snapshot(ctrl; since, lineage)

Return a JSON-friendly, internally consistent copy of the live state.

The live window is mostly unchanged between polls, so we send it incrementally:
when the caller passes the `since`/`lineage` cursor it last saw and that lineage
still matches, only points newer than `since` are encoded (`reset = false`).
A missing cursor or a lineage change (a branch cut) yields the whole window with
`reset = true`, telling the client to replace its buffer rather than append.

Points are returned raw; extending the active path's last value to `current_time`
is a rendering concern owned by the client.
"""
function live_snapshot(ctrl::SimulationController;
                       since::Union{Float64, Nothing}=nothing,
                       lineage::Union{AbstractString, Nothing}=nothing)
    live = ctrl.live
    lock(live.lock) do
        is_reset = isnothing(since) || isnothing(lineage) || lineage != live.active_lineage
        series = Dict{String, Dict{String, Vector{Vector{Any}}}}()
        for (species, path_series) in live.series
            encoded_paths = Dict{String, Vector{Vector{Any}}}()
            for (path, points) in path_series
                encoded_paths[path] = is_reset ?
                    [Any[t, value] for (t, value) in points] :
                    [Any[t, value] for (t, value) in points if t > since]
            end
            series[String(species)] = encoded_paths
        end
        return (
            current_time = live.current_time,
            window_start = max(0.0, live.current_time - live.window),
            frame_count = live.frame_count,
            total_progress = live.total_progress,
            active_lineage = live.active_lineage,
            active_path = live.active_path,
            reset = is_reset,
            series,
        )
    end
end

end # module
