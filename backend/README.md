# Backend

Julia HTTP server (Oxygen.jl) for schedule management and simulation execution (including streaming of results), wrapping the GeneRegulatorySystems.jl package.

## Prerequisites

- Julia 1.10+
- The `grs-package/` directory must be present at the repo root (bundled GeneRegulatorySystems.jl)

## Run

```sh
cd backend
julia --project=. run.jl [host] [port] [--data-dir=<path>] [--examples-dir=<path>]
```

Defaults: `127.0.0.1:8000`, data in `./data/`, examples in `./examples/`.

## Development

Revise.jl is loaded automatically if installed — `run.jl` detects it and enables hot-reload. Use `dev.sh` from the repo root to launch both frontend and backend together:

```sh
./dev.sh
```
