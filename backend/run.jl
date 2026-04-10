#!/usr/bin/env julia
#=
Server startup script.

Usage:
    julia --project=. run.jl [host] [port] [--data-dir=<path>] [--examples-dir=<path>]

Arguments:
    host            Bind address (default: 127.0.0.1)
    port            Listen port (default: 8000)
    --data-dir      Runtime data directory for user schedules/results.
                    Defaults to ./data (relative to this script).
    --examples-dir  Read-only examples directory for curated schedules.
                    Defaults to ./examples (relative to this script).
=#

using Pkg

# Activate the server project
Pkg.activate(@__DIR__)

# Ensure all dependencies are available
Pkg.instantiate()

# Revise is optional (dev-only, not bundled in production)
try
    @eval using Revise
    @info "Revise loaded"
catch
    @debug "Revise not available (expected in production)"
end

using Logging

global_logger(ConsoleLogger(stderr, Logging.Info))

import JSON
JSON.lower(s::Symbol) = String(s)

using Oxygen
using GRSServer

# Parse command-line args
host = "127.0.0.1"
port = 8000
data_dir = joinpath(@__DIR__, "data")
examples_dir = joinpath(@__DIR__, "examples")

for arg in ARGS
    if startswith(arg, "--data-dir=")
        global data_dir = arg[length("--data-dir=") + 1:end]
    elseif startswith(arg, "--examples-dir=")
        global examples_dir = arg[length("--examples-dir=") + 1:end]
    end
end
# Positional args (host, port) — skip flags
positional = filter(a -> !startswith(a, "--"), ARGS)
if length(positional) >= 1
    host = positional[1]
end
if length(positional) >= 2
    port = parse(Int, positional[2])
end

# Configure storage paths
@info "Data directory: $data_dir"
@info "Examples directory: $examples_dir"
GRSServer.set_examples_dir(examples_dir)
GRSServer.set_data_dir(data_dir)

# Start server (enable Revise hot-reload only when available)
revise_mode = isdefined(Main, :Revise) ? :lazy : :off
GRSServer.serve(revise=revise_mode, middleware=[Cors()], host=host, port=port)
