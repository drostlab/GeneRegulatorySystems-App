"""
    SimulationController

Manages the lifecycle of a running simulation: pause/resume, gene subscriptions,
and progress reporting via WebSocket.
"""
module SimulationControl

using JSON
using HTTP
import HTTP: send
using Logging

export SimulationController, check_pause!, subscribe_genes!, is_paused, pause!, resume!

"""
    SimulationController

Controls a running simulation's pause/resume state and gene subscriptions.

The sink checks `check_pause!()` at each trace callback. If paused, the
simulation thread blocks on a `Condition` until resumed.

# Fields
- `paused::Bool`: Whether the simulation is currently paused
- `pause_condition::Threads.Condition`: Condition variable for blocking on pause
- `subscribed_species::Set{Symbol}`: Species names to stream via WS
- `result_path::String`: Path to result directory (for metadata updates)
- `simulation_id::String`: ID for WS message tagging
- `ws_ref::Ref{Union{HTTP.WebSocket, Nothing}}`: shared ref to current WS client (looked up lazily on each send)
- `ws_lock::ReentrantLock`: lock protecting `ws_ref` access
"""
mutable struct SimulationController
    paused::Bool
    pause_condition::Threads.Condition
    subscribed_species::Set{Symbol}
    result_path::String
    simulation_id::String
    ws_ref::Ref{Union{HTTP.WebSocket, Nothing}}
    ws_lock::ReentrantLock

    function SimulationController(;
        result_path::String,
        simulation_id::String,
        ws_ref::Ref{Union{HTTP.WebSocket, Nothing}} = Ref{Union{HTTP.WebSocket, Nothing}}(nothing),
        ws_lock::ReentrantLock = ReentrantLock(),
        subscribed_species::Set{Symbol} = Set{Symbol}()
    )
        new(false, Threads.Condition(), subscribed_species, result_path, simulation_id, ws_ref, ws_lock)
    end
end

"""Look up the current WebSocket client from the shared ref."""
function _get_ws(ctrl::SimulationController)::Union{HTTP.WebSocket, Nothing}
    lock(ctrl.ws_lock) do
        ctrl.ws_ref[]
    end
end

"""
    check_pause!(ctrl) -> nothing

Called by the streaming sink at each trace callback.
Blocks if the simulation is paused until `resume!()` is called.
"""
function check_pause!(ctrl::SimulationController)
    lock(ctrl.pause_condition) do
        while ctrl.paused
            @info "[SimulationController] Simulation paused, waiting..." id=ctrl.simulation_id
            wait(ctrl.pause_condition)
        end
    end
end

"""
    pause!(ctrl)

Pause the simulation. The next `check_pause!()` call will block.
"""
function pause!(ctrl::SimulationController)
    lock(ctrl.pause_condition) do
        ctrl.paused = true
    end
    @info "[SimulationController] Paused" id=ctrl.simulation_id
end

"""
    resume!(ctrl)

Resume a paused simulation. Unblocks the thread waiting in `check_pause!()`.
"""
function resume!(ctrl::SimulationController)
    lock(ctrl.pause_condition) do
        ctrl.paused = false
        notify(ctrl.pause_condition)
    end
    @info "[SimulationController] Resumed" id=ctrl.simulation_id
end

is_paused(ctrl::SimulationController) = ctrl.paused

"""
    subscribe_genes!(ctrl, species)

Update the set of species to stream via WebSocket.
"""
function subscribe_genes!(ctrl::SimulationController, species::Vector{String})
    ctrl.subscribed_species = Set(Symbol.(species))
    @debug "[SimulationController] Updated subscriptions" species=species count=length(species)
end

"""
    send_progress(ctrl, current_time, frame_count)

Send a progress message to the WebSocket client.
"""
function send_progress(ctrl::SimulationController, current_time::Float64, frame_count::Int)
    ws = _get_ws(ctrl)
    isnothing(ws) && return

    msg = Dict(
        "type" => "progress",
        "simulation_id" => ctrl.simulation_id,
        "current_time" => current_time,
        "frame_count" => frame_count
    )

    try
        send(ws, JSON.json(msg))
    catch e
        @warn "[SimulationController] Failed to send progress" exception=string(e)
    end
end

"""
    send_timeseries(ctrl, timeseries_data)

Send incremental timeseries data for subscribed species via WebSocket.
`timeseries_data` is Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}}
(species -> path -> [(t, count)]).
"""
function send_timeseries(ctrl::SimulationController, timeseries_data::Dict{Symbol, Dict{String, Vector{Tuple{Float64, Int}}}})
    isempty(timeseries_data) && return
    ws = _get_ws(ctrl)
    isnothing(ws) && return

    # Convert to JSON-friendly format: { species: { path: [[t, v], ...] } }
    data = Dict{String, Dict{String, Vector{Vector{Any}}}}()
    for (species, path_data) in timeseries_data
        species_str = String(species)
        data[species_str] = Dict{String, Vector{Vector{Any}}}()
        for (path, points) in path_data
            data[species_str][path] = [[t, v] for (t, v) in points]
        end
    end

    msg = Dict(
        "type" => "timeseries",
        "simulation_id" => ctrl.simulation_id,
        "data" => data
    )

    try
        send(ws, JSON.json(msg))
    catch e
        @warn "[SimulationController] Failed to send timeseries" exception=string(e)
    end
end

"""
    send_status(ctrl, status; error=nothing)

Send a status change message via WebSocket.
"""
function send_status(ctrl::SimulationController, status::String; error::Union{String, Nothing} = nothing)
    ws = _get_ws(ctrl)
    if isnothing(ws)
        @warn "[SimulationController] send_status: ws is nothing, cannot send" status=status id=ctrl.simulation_id
        return
    end

    msg = Dict{String, Any}(
        "type" => "status",
        "simulation_id" => ctrl.simulation_id,
        "status" => status
    )
    !isnothing(error) && (msg["error"] = error)

    try
        send(ws, JSON.json(msg))
    catch e
        @warn "[SimulationController] Failed to send status" exception=string(e)
    end
end

end # module
