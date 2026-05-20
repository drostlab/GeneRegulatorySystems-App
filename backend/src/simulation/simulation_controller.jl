"""
    SimulationController

Manages the lifecycle of a running simulation: pause/resume, gene subscriptions,
and a single thread-safe WebSocket send entry point.
"""
module SimulationControl

using JSON
using HTTP
import HTTP: send
using Logging

export SimulationController, check_pause!, subscribe_genes!, is_paused, pause!, resume!
export send!, send_status

"""
    SimulationController

Controls a running simulation's pause/resume state, gene subscriptions, and is
the sole entry point for WebSocket sends from the simulation thread(s).

# Fields
- `paused::Bool`
- `pause_condition::Threads.Condition` -- producers block here when paused
- `subscribed_species::Set{Symbol}` -- species to stream (read by sink; replaced atomically by `subscribe_genes!`)
- `result_path::String`
- `simulation_id::String` -- tagged into every outbound WS message
- `ws_ref::Ref{Union{HTTP.WebSocket, Nothing}}` -- shared current WS client
- `ws_lock::ReentrantLock` -- serialises both ws_ref reads and `send` calls
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

# ============================================================================
# Pause / resume
# ============================================================================

"""
    check_pause!(ctrl)

Blocks until `resume!()` is called if the simulation is currently paused.
Must be called *outside* any sink-internal lock, so paused producers don't
hold the sink lock while waiting.
"""
function check_pause!(ctrl::SimulationController)
    lock(ctrl.pause_condition) do
        while ctrl.paused
            @info "[SimulationController] Simulation paused, waiting..." id=ctrl.simulation_id
            wait(ctrl.pause_condition)
        end
    end
end

function pause!(ctrl::SimulationController)
    lock(ctrl.pause_condition) do
        ctrl.paused = true
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

is_paused(ctrl::SimulationController) = ctrl.paused

# ============================================================================
# Subscriptions
# ============================================================================

"""
    subscribe_genes!(ctrl, species)

Replace the set of subscribed species. The sink reads `subscribed_species`
directly; replacement is a single pointer write, so readers see either the old
or the new set, never a torn one.
"""
function subscribe_genes!(ctrl::SimulationController, species::Vector{String})
    ctrl.subscribed_species = Set(Symbol.(species))
    @debug "[SimulationController] Updated subscriptions" species=species count=length(species)
end

# ============================================================================
# WebSocket send (sole entry point)
# ============================================================================

"""
    send!(ctrl, msg::AbstractDict)

Send a JSON message to the current WebSocket client. Thread-safe: the lock
serialises concurrent senders so frames never interleave on the wire.
No-op if no client is connected. Send failures are logged, not raised.
"""
function send!(ctrl::SimulationController, msg::AbstractDict)
    lock(ctrl.ws_lock) do
        ws = ctrl.ws_ref[]
        isnothing(ws) && return
        try
            send(ws, JSON.json(msg))
        catch e
            @warn "[SimulationController] WS send failed" exception=string(e)
        end
    end
end

"""
    send_status(ctrl, status; error=nothing)

Convenience wrapper for status messages.
"""
function send_status(ctrl::SimulationController, status::String; error::Union{String, Nothing} = nothing)
    msg = Dict{String, Any}(
        "type" => "status",
        "simulation_id" => ctrl.simulation_id,
        "status" => status,
    )
    !isnothing(error) && (msg["error"] = error)
    send!(ctrl, msg)
end

end # module
