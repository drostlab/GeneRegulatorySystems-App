module GRSServer

using Oxygen; @oxidize
using HTTP
using HTTP.WebSockets
using JSON
using Logging
using Dates
using Arrow
using PrecompileTools: @setup_workload, @compile_workload

using GeneRegulatorySystems
using GeneRegulatorySystems.Models
using GeneRegulatorySystems.Models.Scheduling

# Include submodules
include("schedule_bindings.jl")
include("network_representation.jl")
include("simulation/gap_tracking.jl")
include("simulation/simulation_controller.jl")
include("simulation/streaming_sink.jl")
include("schedule/schedule_storage.jl")
include("schedule/schedule_visualisation.jl")
include("simulation/simulation.jl")
include("simulation/viewport.jl")
include("simulation/timeseries_summary.jl")
include("phase_space.jl")

# Use submodules
using .ScheduleBindings
using .NetworkRepresentation
using .GapTracking
using .ScheduleStorage
using .StreamingSink
using .Simulation
using .Viewport
using .SimulationControl
using .ScheduleVisualization
using .PhaseSpace
using .TimeseriesSummary
using Base: @kwdef

# ============================================================================
# Data directory configuration
# ============================================================================

"""
    set_data_dir(path::String)

Configure the runtime data directory for user schedules and simulation results.
Creates the directory tree if it does not exist.
"""
function set_data_dir(path::String)
    mkpath(path)
    ScheduleStorage.set_data_dir(path)
    Simulation.set_base_dir(joinpath(path, "results"))
    @info "Data directory configured" path
end

"""
    set_examples_dir(path::String)

Configure the read-only examples directory for curated schedules.
"""
function set_examples_dir(path::String)
    ScheduleStorage.set_examples_dir(path)
    @info "Examples directory configured" path
end

### Health check

@get "/health" function()
    return Dict("status" => "ok")
end

### Schedule service

# return available schedule keys (in format "source/name")
@get "/schedules" function()
    ScheduleStorage.list_all_schedules()::Vector{String}
end

# return spec for a given schedule key (in string format)
@get "/schedules/{source}/{name}/spec" function(_, source::String, name::String)
    ScheduleStorage.get_schedule_spec(name, source)::String
end

# return full schedule object for a stored schedule (includes validation and visualization data)
@get "/schedules/{source}/{name}" function(_, source::String, name::String)
    spec_str = ScheduleStorage.get_schedule_spec(name, source)
    isnothing(spec_str) && return HTTP.Response(404, "Schedule not found")
    return ScheduleVisualization.reify_schedule(spec_str, name=name, source=source)::ScheduleVisualization.ReifiedSchedule
end

@kwdef struct LoadScheduleRequest
    schedule_name::String
    schedule_spec::String
    schedule_source::String = "snapshot"
end
# validate and generate visualization for schedule spec
@post "/schedules/load" function(req, data::Json{LoadScheduleRequest})
    return ScheduleVisualization.reify_schedule(
        data.payload.schedule_spec;
        name=data.payload.schedule_name,
        source=data.payload.schedule_source,
    )::ScheduleVisualization.ReifiedSchedule
end

@kwdef struct UploadScheduleRequest
    schedule_name::String
    schedule_spec::String
    original_name::Union{String, Nothing} = nothing
    original_source::Union{String, Nothing} = nothing
end
# upload and save schedule to user storage
@post "/schedules/upload" function(req, data::Json{UploadScheduleRequest})
    payload = data.payload
    ScheduleStorage.save_user_schedule(payload.schedule_name, payload.schedule_spec)

    # A renamed user schedule is a move, not a copy. Bundled examples are
    # read-only, so saving one still creates a user-owned version.
    if payload.original_source == "user" &&
       !isnothing(payload.original_name) &&
       payload.original_name != payload.schedule_name
        ScheduleStorage.delete_user_schedule(payload.original_name)
    end

    return ScheduleVisualization.reify_schedule(payload.schedule_spec, name=payload.schedule_name, source="user")::ScheduleVisualization.ReifiedSchedule
end

# extract network for a stored schedule by model_path
@get "/schedules/{source}/{name}/network" function(req, source::String, name::String)
    model_path = get(HTTP.queryparams(HTTP.URI(req.target)), "model_path", nothing)
    isnothing(model_path) && return HTTP.Response(400, "model_path query parameter required")
    spec_str = ScheduleStorage.get_schedule_spec(name, source)
    isnothing(spec_str) && return HTTP.Response(404, "Schedule not found")
    return ScheduleVisualization.extract_network_for_model_path(spec_str, model_path)::ScheduleVisualization.Network
end

@kwdef struct NetworkFromSpecRequest
    schedule_spec::String
    model_path::String
end
# extract network from spec + model_path
@post "/schedules/network" function(req, data::Json{NetworkFromSpecRequest})
    return ScheduleVisualization.extract_network_for_model_path(data.payload.schedule_spec, data.payload.model_path)::ScheduleVisualization.Network
end

@kwdef struct UnionNetworkRequest
    schedule_spec::String
    segments::Vector{ScheduleVisualization.TimelineSegment}
end
# extract union network across all model paths
@post "/schedules/union-network" function(req, data::Json{UnionNetworkRequest})
    return ScheduleVisualization.extract_union_network(data.payload.schedule_spec, data.payload.segments)::ScheduleVisualization.UnionNetwork
end


### Simulation service

# list all simulation results
@get "/simulations" function()
    return Simulation.list_results()::Vector{Simulation.SimulationResult}
end

# get simulation result (metadata only, no frames)
@get "/simulations/{id}" function(_, id::String)
    result = Simulation.load_result(id)
    isnothing(result) && return HTTP.Response(404, "Result not found")
    return result::Simulation.SimulationResult
end

# get phase-space result for a completed simulation
@get "/simulations/{id}/phasespace" function(_, id::String)
    result = Simulation.load_result(id)
    isnothing(result) && return HTTP.Response(404, "Result not found")
    ps = PhaseSpace.load_phasespace(result.path)
    isnothing(ps) && return HTTP.Response(404, "Phase-space result not available")
    return ps
end

@kwdef struct TimeseriesRequest
    species::Vector{String}
end
# get filtered timeseries for specific species
@post "/simulations/{id}/timeseries" function(req, id::String, data::Json{TimeseriesRequest})
    result = Simulation.load_result(id)
    isnothing(result) && return HTTP.Response(404, "Result not found")
    species_filter = Set(Symbol.(data.payload.species))
    index_file = joinpath(result.path, "index.arrow")
    isfile(index_file) || return HTTP.Response(422, "Result is missing index data — it may be from an older format or still running")
    timeseries = Simulation.load_timeseries_for_species(result.path, species_filter)
    return Simulation.SimulationData(; timeseries)
end

@kwdef struct TimeseriesSummaryRequest
    species::Vector{String}
    n_points::Int = 500
end
# compute mean + SE across execution paths for the requested species
@post "/simulations/{id}/timeseries/summary" function(req, id::String, data::Json{TimeseriesSummaryRequest})
    result = Simulation.load_result(id)
    isnothing(result) && return HTTP.Response(404, "Result not found")
    species_filter = Set(Symbol.(data.payload.species))
    summaries = TimeseriesSummary.compute_summary(result.path, species_filter; n_points=data.payload.n_points)
    # Convert to JSON-friendly format
    out = Dict{String, Any}()
    for (sp, s) in summaries
        out[string(sp)] = Dict("time" => s.time, "mean" => s.mean, "se" => s.se)
    end
    return Dict("summary" => out)
end

@kwdef struct ViewportRequest
    species::Vector{String}
    paths::Union{Vector{String}, Nothing} = nothing  # nothing = all paths of each species
    t0::Float64
    t1::Float64
    width_px::Int = 1000
end
# adaptive viewport query: ≲2·width_px decimated OHLC-step points per (species, path)
@post "/simulations/{id}/timeseries/viewport" function(req, id::String, data::Json{ViewportRequest})
    result = Simulation.load_result(id)
    isnothing(result) && return HTTP.Response(404, "Result not found")
    p = data.payload

    timeseries = Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}}()
    for sp_str in p.species
        sp = Symbol(sp_str)
        paths = isnothing(p.paths) ? Viewport.paths_for(result.path, sp) : p.paths
        series_map = Dict{String, Vector{Tuple{Float64, Int}}}()
        for path in paths
            series = Viewport.query_species(result.path, sp, path, p.t0, p.t1, p.width_px)
            isnothing(series) && continue
            series_map[path] = series
        end
        isempty(series_map) || (timeseries[sp] = series_map)
    end
    return Simulation.SimulationData(; timeseries)
end

const ws_client = Ref{Union{Nothing, HTTP.WebSocket}}(nothing)
const WS_LOCK = ReentrantLock()
const simulation_task = Ref{Union{Nothing, Task}}(nothing)
const active_controller = Ref{Union{Nothing, SimulationController}}(nothing)

@websocket "/ws" function(ws::HTTP.WebSocket)
    @info "WebSocket client connected"
    lock(WS_LOCK) do
        ws_client[] = ws
    end

    for raw_msg in ws
        _handle_ws_message(raw_msg)
    end

    lock(WS_LOCK) do
        ws_client[] = nothing
    end
    close(ws)
    @info "WebSocket client disconnected"
end

function _handle_ws_message(raw::String)
    msg = JSON.parse(raw)
    msg_type = haskey(msg, "type") ? msg["type"] : ""
    @info "[WS] Received message" type=msg_type
    ctrl = active_controller[]

    if msg_type == "subscribe"
        species = haskey(msg, "species") ? msg["species"] : String[]
        if !isnothing(ctrl)
            subscribe_genes!(ctrl, convert(Vector{String}, species))
            @debug "[WS] Subscribed to species" count=length(species)
        end
    elseif msg_type == "pause"
        if !isnothing(ctrl)
            pause!(ctrl)
            Simulation.update_result_metadata(ctrl.result_path; status="paused")
        end
    elseif msg_type == "resume"
        if !isnothing(ctrl)
            resume!(ctrl)
            Simulation.update_result_metadata(ctrl.result_path; status="running")
        end
    else
        @warn "[WS] Unknown message type" msg_type
    end
end

@kwdef struct RunSimulationRequest
    schedule_name::String
    schedule_spec::String
    max_time::Float64 = 0.0
    subscribed_species::Vector{String} = String[]
end

# start a simulation run (async, streamed via WS)
@post "/simulations/run" function(req, data::Json{RunSimulationRequest})
    spec = data.payload.schedule_spec
    max_time = data.payload.max_time

    # Single reify pass: populates the spec cache with the parsed GRSSchedule,
    # validation messages, segments, and gene colours.  Subsequent lookups are
    # dict reads.
    reified = ScheduleVisualization.reify_schedule(spec, name=data.payload.schedule_name)
    ScheduleVisualization.is_valid(reified) || return HTTP.Response(400, "Invalid schedule: $(ScheduleVisualization.get_error_messages(reified))")

    model = ScheduleVisualization.cache_entry(spec).grs_schedule
    gene_colours = reified.data.gene_colours
    timeline_segments = reified.data.segments

    # Prepare result directory and metadata
    result = Simulation.prepare_result(data.payload.schedule_name, spec; max_time)

    # Create simulation controller for pause/resume and gene subscriptions.
    # Uses ws_client/WS_LOCK refs so the controller lazily reads the latest WS
    # client on each send (handles the race where WS connects after POST fires).
    initial_species = Set(Symbol.(data.payload.subscribed_species))
    ctrl = SimulationController(
        result_path = result.path,
        simulation_id = result.id,
        ws_ref = ws_client,
        ws_lock = WS_LOCK,
        subscribed_species = initial_species
    )
    active_controller[] = ctrl

    # Spawn async simulation task
    simulation_task[] = @async begin
        Simulation.run_simulation(result, model; controller = ctrl, segments = timeline_segments)
        active_controller[] = nothing

        # After simulation completes, compute phase-space embedding on a thread
        # so we don't block the event loop.  Notify the client when ready.
        local sim_id   = result.id
        local res_path = result.path
        Threads.@spawn begin
            @info "[PhaseSpace] Spawning computation" sim_id
            ps = try
                PhaseSpace.compute_and_store(res_path, sim_id, gene_colours)
            catch e
                @error "[PhaseSpace] Computation failed" sim_id exception=e
                nothing
            end
            if !isnothing(ps)
                lock(WS_LOCK) do
                    ws = ws_client[]
                    if !isnothing(ws)
                        try
                            send(ws, JSON.json(Dict(
                                "type"          => "phasespace_ready",
                                "simulation_id" => sim_id,
                            )))
                            @info "[PhaseSpace] Notified client" sim_id
                        catch e
                            @warn "[PhaseSpace] WS notification failed" sim_id exception=e
                        end
                    end
                end
            end
        end
    end

    # Return immediately with status=running
    return result::Simulation.SimulationResult
end

# ============================================================================
# Precompile workload
#
# Exercises the cold-start hot paths (spec parse → GRSSchedule build →
# reify → network extraction → integrator dispatch) so type inference is
# cached in the package image.  Uses a tiny inlined spec with short `to`
# to keep build time low.  Runtime codegen inside GRS.jl is not captured
# here — that work still happens on first real request.
# ============================================================================

const PRECOMPILE_SPEC = """
{
    "to": 10.0,
    "step": [
        {"{add}": {"polymerases": 5e5, "ribosomes": 2e6, "proteasomes": 1e6}},
        {"{regulation/v1}": {"genes": [
            {"base_rates": {
                "activation": 2.5, "deactivation": 10.0, "trigger": 6.6e-7,
                "transcription": 0.001, "processing": 0.02, "translation": 2.5e-9,
                "abortion": 0.01, "premrna_decay": 0.001, "mrna_decay": 0.001,
                "protein_decay": 3e-10
            }}
        ]}}
    ]
}
"""

@setup_workload begin
    @compile_workload begin
        reified = ScheduleVisualization.reify_schedule(PRECOMPILE_SPEC; name="precompile")
        if reified.data !== nothing
            ScheduleVisualization.extract_union_network(PRECOMPILE_SPEC, reified.data.segments)
            schedule = ScheduleVisualization.cache_entry(PRECOMPILE_SPEC).grs_schedule
            state = Models.FlatState()
            schedule(state, Inf; trace = (args...; kwargs...) -> nothing)
        end
        ScheduleVisualization.clear_spec_cache()
    end
end

end
