"""
    Simulation

Module for managing simulation execution, storage, and loading.

Handles result metadata, result listing/loading, and integration with StreamingSink
for incremental Arrow storage during execution.
"""
module Simulation

using Dates
using JSON
using Arrow
import Tables

import ..StreamingSink
import ..ScheduleStorage
import ..SimulationControl: SimulationController, check_pause!, send_progress, send_timeseries, send_status
import ..GapTracking: GapTracker, register_episode!, check_gap, check_synthetic_start
import GeneRegulatorySystems.Models
import GeneRegulatorySystems.Models.Scheduling
import HTTP
import HTTP: send

# Re-export SimulationFrame from StreamingSink
export SimulationFrame, SimulationData, SimulationResult, SimulationController
export update_result_metadata, load_result, list_results, delete_result,
       get_result_path, load_timeseries_for_species, results_dir,
       set_base_dir

# ============================================================================
# Types
# ============================================================================

# Re-export from StreamingSink
const SimulationFrame = StreamingSink.SimulationFrame

"""
    SimulationData

Container for simulation timeseries data.

# Fields
- `timeseries::Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}}`:
  Timeseries data nested by species symbol → execution path → [(time, count), ...]
  Each path's timeseries is sorted by time.
"""
@kwdef struct SimulationData
    timeseries::Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}} = Dict()
end

"""
    SimulationResult

Unified simulation result. Timeseries data is always loaded lazily via
the `/simulations/{id}/timeseries` endpoint.

# Fields
- `id::String`: Unique simulation ID (ISO 8601 timestamp)
- `created_at::DateTime`: When simulation was run
- `schedule_name::String`: Name of the schedule that was run
- `schedule_spec::String`: JSON schedule specification
- `status::String`: "running", "paused", "completed", or "error"
- `frame_count::Int`: Number of frames collected so far
- `current_time::Float64`: Current simulation time (for progress tracking)
- `max_time::Float64`: Maximum simulation time (from schedule extent)
- `error::Union{String, Nothing}`: Error message if status is "error"
- `path::String`: Path to stored result directory (internal use, not serialised)
"""
@kwdef struct SimulationResult
    id::String
    created_at::DateTime
    schedule_name::String = ""
    schedule_spec::String = ""
    status::String
    frame_count::Int = 0
    current_time::Float64 = 0.0
    max_time::Float64 = 0.0
    error::Union{String, Nothing} = nothing
    path::String = ""  # Internal use, not sent to frontend
end

# ============================================================================
# Storage Management
# ============================================================================

"""Module-level configurable base directory for simulation results."""
const _base_dir = Ref{String}(joinpath(@__DIR__, "..", "..", "data", "results"))

"""
    set_base_dir(path::String)

Set the base directory for simulation results.
Creates the directory if needed.
"""
function set_base_dir(path::String)
    _base_dir[] = path
    mkpath(path)
    @debug "Simulation base directory set" path
end

"""
    results_dir()

Get the results directory path, creating it if needed.
"""
function results_dir()
    dir = _base_dir[]
    mkpath(dir)
    return dir
end

"""
    get_result_path(simulation_id::String)

Get the directory path for a specific simulation result.
"""
function get_result_path(simulation_id::String)
    joinpath(results_dir(), simulation_id)
end

"""
    generate_simulation_id()

Generate a unique simulation ID using a filesystem-safe timestamp.

Format: YYYY-MM-DD_HH-MM-SS (e.g., 2025-11-24_23-00-33)
"""
function generate_simulation_id()
    Dates.format(now(), "yyyy-mm-dd_HH-MM-SS")
end

# ============================================================================
# Result Preparation and Execution
# ============================================================================

"""
    prepare_result(schedule_name, schedule_spec; max_time=0.0) -> SimulationResult

Prepare a simulation result directory with initial metadata.

Creates result directory, writes schedule snapshot, and initialises metadata.json
with status=running.
"""
function prepare_result(schedule_name::String, schedule_spec::String; max_time::Float64 = 0.0)::SimulationResult
    result_id = generate_simulation_id()
    result_path = get_result_path(result_id)
    mkpath(result_path)

    # Write schedule snapshot
    open(joinpath(result_path, "schedule.json"), "w") do f
        write(f, schedule_spec)
    end

    # Write initial metadata
    metadata = Dict(
        "id" => result_id,
        "schedule_name" => schedule_name,
        "status" => "running",
        "frame_count" => 0,
        "current_time" => 0.0,
        "max_time" => max_time
    )

    open(joinpath(result_path, "metadata.json"), "w") do f
        JSON.print(f, metadata, 2)
    end

    created_at = try
        Dates.DateTime(result_id, "yyyy-mm-dd_HH-MM-SS")
    catch
        now()
    end

    return SimulationResult(
        id = result_id,
        created_at = created_at,
        schedule_name = schedule_name,
        schedule_spec = schedule_spec,
        status = "running",
        frame_count = 0,
        current_time = 0.0,
        max_time = max_time,
        path = result_path
    )
end

"""
    run_simulation(result, schedule; controller=nothing, segments=nothing)

Execute a simulation, stream progress/timeseries via WS, and write results to disk.

If `segments` is provided (from reify_schedule), per-segment progress tracking is enabled.
"""
function run_simulation(result::SimulationResult, schedule::Models.Model;
                        controller::Union{SimulationController, Nothing} = nothing,
                        segments = nothing)
    @info "[Simulation] Starting simulation" id=result.id schedule=result.schedule_name

    sink = StreamingSink.StreamingSimulationSink(
        location = result.path,
        controller = controller
    )

    # Initialise per-segment progress tracking if segments are available
    if segments !== nothing
        StreamingSink.set_segments!(sink, segments)
    end

    state = Models.FlatState()

    # Execute schedule with sink as trace callback.
    #
    # `dense = true` makes JumpModel record every stochastic event so the sink's
    # `each_event` iteration yields full trajectories — what our timeseries
    # plots need. It is safe to set globally: the scheduler forces `dense=false`
    # for step-based (skip) episodes, so discrete-sampling schedules still emit
    # one sample per step rather than the whole trajectory. (See the Slice vs
    # skip branches in GRS.jl scheduling.jl.)
    @info "[Simulation] Executing schedule" id=result.id
    schedule(state, Inf; trace = sink, dense = true)

    # Flush remaining buffered events and stream frames
    @info "[Simulation] Flushing events" id=result.id
    StreamingSink.flush!(sink)

    # Count frames from Arrow files
    @info "[Simulation] Counting frames" id=result.id
    frame_count = count_frames_in_result(result.path)
    @info "[Simulation] Frame count" id=result.id frames=frame_count

    # Update metadata with final status
    @info "[Simulation] Updating metadata" id=result.id status="completed" frames=frame_count
    update_result_metadata(
        result.path;
        status = "completed",
        frame_count = frame_count,
        current_time = result.max_time
    )

    # Notify WebSocket client of completion via controller
    if !isnothing(controller)
        send_status(controller, "completed")
    end
    @info "[Simulation] Completed successfully" id=result.id
end

"""
    count_frames_in_result(result_path::String)::Int

Internal: count frames by reading Arrow event files.

Each unique (episode_i, time) pair represents one frame.
"""
function count_frames_in_result(result_path::String)::Int
    frame_count = 0
    all_files = readdir(result_path)
    @debug "[Simulation] Reading result directory" path=result_path files=all_files

    for file in all_files
        if startswith(file, "events") && endswith(file, ".stream.arrow")
            events_file = joinpath(result_path, file)
            @debug "[Simulation] Counting frames in Arrow file" file=file
            events_table = Arrow.Table(events_file)
            unique_states = Set()
            for (i_val, t_val) in zip(events_table.i, events_table.t)
                push!(unique_states, (i_val, t_val))
            end
            file_frames = length(unique_states)
            frame_count += file_frames
            @debug "[Simulation] Frames in file" file=file count=file_frames total=frame_count
        end
    end
    @info "[Simulation] Total frames counted" total=frame_count
    return frame_count
end

# ============================================================================
# Metadata Management
# ============================================================================



"""
    update_result_metadata(result_path::String; status::String, frame_count::Int,
                          error::Union{String, Nothing}=nothing)

Update result metadata status and frame count (after simulation completion).

Only modifies metadata.json, preserves schedule.json already written.
"""
function update_result_metadata(result_path::String;
                                status::Union{String, Nothing} = nothing,
                                frame_count::Union{Int, Nothing} = nothing,
                                current_time::Union{Float64, Nothing} = nothing,
                                error::Union{String, Nothing} = nothing)
    metadata_file = joinpath(result_path, "metadata.json")

    if !isfile(metadata_file)
        @warn "[Simulation] Metadata file not found" path=result_path
        return
    end

    metadata = JSON.parsefile(metadata_file)

    !isnothing(status) && (metadata["status"] = status)
    !isnothing(frame_count) && (metadata["frame_count"] = frame_count)
    !isnothing(current_time) && (metadata["current_time"] = current_time)
    !isnothing(error) && (metadata["error"] = error)

    @debug "[Simulation] Updating metadata" status frame_count current_time

    open(metadata_file, "w") do f
        JSON.print(f, metadata, 2)
    end
end

# ============================================================================
# Loading Results
# ============================================================================

"""
    load_result(simulation_id) -> SimulationResult | nothing

Load simulation result metadata from disk. Returns nothing if not found.
"""
function load_result(simulation_id::String)::Union{SimulationResult, Nothing}
    result_path = get_result_path(simulation_id)
    !isdir(result_path) && return nothing

    metadata_file = joinpath(result_path, "metadata.json")
    !isfile(metadata_file) && return nothing

    metadata = JSON.parsefile(metadata_file)

    created_at = try
        Dates.DateTime(metadata["id"], "yyyy-mm-dd_HH-MM-SS")
    catch
        now()
    end

    # Load schedule spec from file
    schedule_spec = ""
    schedule_file = joinpath(result_path, "schedule.json")
    if isfile(schedule_file)
        schedule_spec = read(schedule_file, String)
    end

    return SimulationResult(
        id = metadata["id"],
        created_at = created_at,
        schedule_name = get(metadata, "schedule_name", ""),
        schedule_spec = schedule_spec,
        status = get(metadata, "status", "completed"),
        error = get(metadata, "error", nothing),
        frame_count = get(metadata, "frame_count", 0),
        current_time = get(metadata, "current_time", 0.0),
        max_time = get(metadata, "max_time", 0.0),
        path = result_path
    )
end

# ============================================================================
# Listing Results
# ============================================================================

"""
    list_results(; status=nothing) -> Vector{SimulationResult}

List all stored simulation results, optionally filtered by status.
Sorted by creation time (newest first).
"""
function list_results(; status::Union{String, Nothing}=nothing)::Vector{SimulationResult}
    results_path = results_dir()

    if !isdir(results_path)
        return SimulationResult[]
    end

    results = SimulationResult[]

    for dir_entry in readdir(results_path; join=true)
        if isdir(dir_entry)
            sim_id = basename(dir_entry)
            result = load_result(sim_id)

            if !isnothing(result)
                if isnothing(status) || result.status == status
                    push!(results, result)
                end
            end
        end
    end

    # Sort by creation time (newest first)
    sort!(results; by=r -> r.created_at, rev=true)

    return results
end

# ============================================================================
# Deleting Results
# ============================================================================

"""
    delete_result(simulation_id::String)::Bool

Delete a stored simulation result and all associated files.

Returns true if successful, false if result not found.
"""
function delete_result(simulation_id::String)::Bool
    result_path = get_result_path(simulation_id)

    if !isdir(result_path)
        return false
    end

    rm(result_path; recursive=true)
    return true
end

# ============================================================================
# Per-species filtered timeseries loading (lazy)
# ============================================================================

"""
    load_timeseries_for_species(result_path, species_filter) -> Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}}

Load timeseries for only the specified species names.
"""
function load_timeseries_for_species(
    result_path::String,
    species_filter::Set{Symbol}
)::Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}}
    if !isdir(result_path)
        @warn "Result directory not found" result_path
        return Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}}()
    end
    (i_to_path, i_to_from, i_to_max_time) = load_index_mapping(result_path)
    if isempty(i_to_path)
        error("Result is missing index data (index.arrow) — it may be from an older format or corrupt")
    end
    ts = load_events_as_timeseries(result_path, i_to_path, i_to_max_time; i_to_from, species_filter)
    @debug "Loaded filtered timeseries" result_path species_count=length(species_filter) series_count=length(ts)
    return ts
end

"""
    load_events_as_timeseries(result_path, i_to_path, i_to_max_time; species_filter) -> timeseries

Shared core for loading events from Arrow files into timeseries format.

Groups events by (species, path, episode_i), adds an exact endpoint at the scheduled
segment boundary (`i_to_max_time[i]`) for each episode, then flattens to (species, path).
This avoids the path-string collision bug where repeated paths in a looping schedule
would share a single max_time computed across all iterations.

- `species_filter`: if provided, only those species are loaded.
"""
function load_events_as_timeseries(
    result_path::String,
    i_to_path::Dict{Int, String},
    i_to_max_time::Dict{Int, Float64};
    i_to_from::Dict{Int, Float64} = Dict{Int, Float64}(),
    species_filter::Union{Nothing, Set{Symbol}} = nothing
)::Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}}
    # Intermediate: (species → (path, episode_i) → points)
    temp = Dict{Symbol, Dict{Tuple{String, Int}, Vector{Tuple{Float64, Int}}}}()

    for file in readdir(result_path)
        startswith(file, "events") && endswith(file, ".stream.arrow") || continue
        events_table = Arrow.Table(joinpath(result_path, file))
        for (ep_i, t, name, value) in zip(events_table.i, events_table.t, events_table.name, events_table.value)
            !isnothing(species_filter) && !(name in species_filter) && continue
            haskey(i_to_path, ep_i) || error("Episode index $ep_i not found in index.arrow — result may be from an older format without index data")
            path = i_to_path[ep_i]
            episode_map = get!(temp, name) do
                Dict{Tuple{String, Int}, Vector{Tuple{Float64, Int}}}()
            end
            push!(get!(episode_map, (path, ep_i)) do; Tuple{Float64, Int}[] end, (t, value))
        end
    end

    # Build GapTracker from index data
    tracker = GapTracker()
    for ep_i in keys(i_to_path)
        f = get(i_to_from, ep_i, NaN)
        t = get(i_to_max_time, ep_i, NaN)
        (isnan(f) || isnan(t)) && continue
        register_episode!(tracker, i_to_path[ep_i], f, t)
    end

    # Sort per-episode data, inject endpoint, flatten to path.
    timeseries = Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}}()
    for (species, episode_map) in temp
        path_map = get!(timeseries, species) do
            Dict{String, Vector{Tuple{Float64, Int}}}()
        end

        # Group by path so we can sort by from-time and detect gaps
        path_to_eps = Dict{String, Vector{Tuple{Float64, Float64, Vector{Tuple{Float64, Int}}}}}()
        for ((path, ep_i), points) in episode_map
            ep_from = get(i_to_from, ep_i, NaN)
            ep_to   = get(i_to_max_time, ep_i, 0.0)
            push!(get!(path_to_eps, path) do; [] end, (ep_from, ep_to, points))
        end

        for (path, eps) in path_to_eps
            sort!(eps; by = first)  # chronological order
            path_series = get!(path_map, path) do; Tuple{Float64, Int}[] end
            prev_end = NaN

            for (ep_from, ep_to, points) in eps
                sort!(points; by = first)

                # Gap detection via shared tracker
                (insert_gap, gap_t_start, gap_t_end) = check_gap(tracker, path, ep_from, prev_end)
                if insert_gap
                    push!(path_series, (gap_t_start, Int64(-1)))
                    push!(path_series, (gap_t_end, Int64(-1)))
                end

                # Synthetic start-point via shared tracker
                (insert_start, start_t) = check_synthetic_start(tracker, path, ep_from, prev_end)
                if insert_start && !isempty(points) && start_t < first(points[1]) - 1e-9
                    pushfirst!(points, (start_t, points[1][2]))
                end

                # Inject endpoint at scheduled segment boundary
                if ep_to > 0.0 && !isempty(points)
                    last_t, last_v = points[end]
                    if last_t < ep_to
                        push!(points, (ep_to, last_v))
                    end
                end

                append!(path_series, points)
                prev_end = ep_to > 0.0 ? ep_to : (isempty(points) ? prev_end : first(points[end]))
            end
        end
    end

    @debug "load_events_as_timeseries" result_path species_count=length(timeseries)
    return timeseries
end

"""
    load_index_mapping(result_path) -> (i_to_path, i_to_from, i_to_max_time)

Load episode metadata from `index.arrow`.

Returns:
- `i_to_path::Dict{Int, String}`: episode index → execution path
- `i_to_from::Dict{Int, Float64}`: episode index → segment start time (`from` column)
- `i_to_max_time::Dict{Int, Float64}`: episode index → scheduled segment end time (`to` column)

Using the index `to` column avoids the path-string collision bug: when a looping
schedule repeats the same structural path, all iterations share the same path string
but have distinct episode indices with correct individual end times.
"""
function load_index_mapping(result_path::String)::Tuple{Dict{Int, String}, Dict{Int, Float64}, Dict{Int, Float64}}
    i_to_path = Dict{Int, String}()
    i_to_from = Dict{Int, Float64}()
    i_to_max_time = Dict{Int, Float64}()

    index_file = joinpath(result_path, "index.arrow")
    if !isfile(index_file)
        @debug "No index.arrow found" result_path
        return (i_to_path, i_to_from, i_to_max_time)
    end

    index_table = Arrow.Table(index_file)
    for idx in eachindex(index_table.i)
        ep_i = index_table.i[idx]
        i_to_path[ep_i] = string(index_table.path[idx])
        i_to_from[ep_i] = Float64(index_table.from[idx])
        i_to_max_time[ep_i] = Float64(index_table.to[idx])
    end
    @debug "Loaded index mapping" result_path episode_count=length(i_to_path)

    return (i_to_path, i_to_from, i_to_max_time)
end

end # module Simulation
