"""
    PhaseSpace

Post-simulation phase-space / dimensionality-reduction visualisation.

Reads protein-species timeseries from Arrow result files, builds a
cells × genes expression matrix (one row per observed (path, t) event),
applies log1p and an adaptive projection:

  n_genes ≤ 2  → "direct"   — raw gene axes, no transform
  n_genes ≤ 20 → "pca"      — 2 leading PCs (MultivariateStats)
  n_genes > 20 → "pca_umap" — PCA 50 components → UMAP 2-D

Axis labels are human-readable: gene names for direct, "PC1 (42%)" for PCA,
"UMAP 1 / 2" for UMAP.  For PCA axes the top loading gene is also reported.

Colouring:
  - If the schedule has saturated gene colours (e.g. a differentiation model)
    → softmax blend of non-grey protein genes onto their hex colours.
  - Otherwise → colour by execution path, using a fixed hue palette.

The result is stored as `phasespace.json` in the simulation result directory
and the client is notified via WS `{ type: "phasespace_ready", simulation_id }`.
"""
module PhaseSpace

using Arrow
using JSON
using Logging
using MultivariateStats
using UMAP
using Statistics: mean, var

export PhaseSpacePoint, PhaseSpaceResult, compute_and_store, load_phasespace

# ============================================================================
# Types
# ============================================================================

"""A single observation point in the 2-D embedding."""
@kwdef struct PhaseSpacePoint
    x::Float64
    y::Float64
    path::String
    t::Float64
    colour::String
end

"""Full result of one phase-space computation."""
@kwdef struct PhaseSpaceResult
    simulation_id::String
    method::String                  # "direct" | "pca" | "pca_umap"
    axis_labels::Vector{String}     # e.g. ["lacI_protein", "tetR_protein"] or ["PC1 (62%)", "PC2 (31%)"]
    axis_top_genes::Vector{String}  # top-loading gene per axis (empty string for direct/UMAP)
    points::Vector{PhaseSpacePoint}
    n_genes::Int
    n_cells::Int
end

# ============================================================================
# Public API
# ============================================================================

"""
    compute_and_store(result_path, simulation_id, gene_colours) -> PhaseSpaceResult | Nothing

Compute the phase-space embedding, store as `phasespace.json`, and return the
result.  Returns `nothing` on failure.

`gene_colours`: `Dict{String,String}` from `ScheduleVisualization.gene_colours_from_spec`.
"""
function compute_and_store(
    result_path::String,
    simulation_id::String,
    gene_colours::Dict{String,String},
)::Union{PhaseSpaceResult, Nothing}
    @info "[PhaseSpace] Starting computation" simulation_id

    protein_series = _load_protein_timeseries(result_path)
    if isempty(protein_series)
        @warn "[PhaseSpace] No protein species found" simulation_id
        return nothing
    end

    gene_names = sort(collect(keys(protein_series)), by = string)  # Vector{Symbol}
    n_genes    = length(gene_names)

    cells   = _collect_cells(result_path, protein_series)
    n_cells = length(cells)
    if n_cells < 4
        @warn "[PhaseSpace] Too few cells for embedding" simulation_id n_cells
        return nothing
    end

    @info "[PhaseSpace] Building expression matrix" n_cells n_genes
    X = _build_expression_matrix(cells, gene_names, protein_series)  # n_cells × n_genes
    X .= log1p.(X)

    method = _choose_method(n_genes)
    @info "[PhaseSpace] Using method" method n_genes

    coords, axis_labels, axis_top_genes = _project(X, gene_names, n_cells, n_genes, method)
    coords === nothing && return nothing  # 2 × n_cells

    colours = _compute_colours(X, cells, gene_names, gene_colours)

    points = [
        PhaseSpacePoint(
            x      = coords[1, i],
            y      = coords[2, i],
            path   = cells[i][1],
            t      = cells[i][2],
            colour = colours[i],
        )
        for i in 1:n_cells
    ]

    result = PhaseSpaceResult(;
        simulation_id,
        method = string(method),
        axis_labels,
        axis_top_genes,
        points,
        n_genes,
        n_cells,
    )
    _store(result_path, result)

    @info "[PhaseSpace] Completed" simulation_id n_cells n_genes method
    return result
end

"""
    load_phasespace(result_path) -> PhaseSpaceResult | Nothing

Load a previously stored phase-space result from `phasespace.json`.
"""
function load_phasespace(result_path::String)::Union{PhaseSpaceResult, Nothing}
    meta_file = joinpath(result_path, "phasespace.json")
    tsv_file  = joinpath(result_path, "phasespace.tsv")
    isfile(meta_file) || return nothing

    data = JSON.parsefile(meta_file)

    # Read points from TSV (new format) or inline JSON (legacy)
    if isfile(tsv_file)
        points = _read_points_tsv(tsv_file)
    elseif haskey(data, "points")
        points = [
            PhaseSpacePoint(
                x = p["x"], y = p["y"], path = p["path"],
                t = p["t"], colour = p["colour"],
            )
            for p in data["points"]
        ]
    else
        return nothing
    end

    return PhaseSpaceResult(
        simulation_id   = data["simulation_id"],
        method          = data["method"],
        axis_labels     = data["axis_labels"],
        axis_top_genes  = data["axis_top_genes"],
        points          = points,
        n_genes         = data["n_genes"],
        n_cells         = data["n_cells"],
    )
end

"""Read phase-space points from a TSV file (header + data rows)."""
function _read_points_tsv(path::String)::Vector{PhaseSpacePoint}
    lines = readlines(path)
    length(lines) < 2 && return PhaseSpacePoint[]
    points = Vector{PhaseSpacePoint}(undef, length(lines) - 1)
    for i in 2:length(lines)
        parts = split(lines[i], '\t')
        points[i - 1] = PhaseSpacePoint(
            x      = parse(Float64, parts[1]),
            y      = parse(Float64, parts[2]),
            path   = String(parts[3]),
            t      = parse(Float64, parts[4]),
            colour = String(parts[5]),
        )
    end
    return points
end

# ============================================================================
# Internal: method selection
# ============================================================================

function _choose_method(n_genes::Int)::Symbol
    n_genes <= 2  && return :direct
    n_genes <= 20 && return :pca
    return :pca_umap
end

# ============================================================================
# Internal: projection dispatch
# ============================================================================

"""
Dispatch to the correct projection.  Returns `(2 × n_cells matrix, axis_labels, axis_top_genes)`
or `(nothing, ...)` on failure.
"""
function _project(
    X::Matrix{Float64},
    gene_names::Vector{Symbol},
    n_cells::Int,
    n_genes::Int,
    method::Symbol,
)::Tuple{Union{Matrix{Float64}, Nothing}, Vector{String}, Vector{String}}
    if method == :direct
        return _run_direct(X, gene_names, n_genes)
    elseif method == :pca
        return _run_pca_2d(X, gene_names, n_cells)
    else  # :pca_umap
        return _run_pca_umap(X, gene_names, n_cells, n_genes)
    end
end

# ── Direct ────────────────────────────────────────────────────────────────────

"""
For n_genes ≤ 2: use gene columns directly as x/y axes.
Pick the two highest-variance columns when there is more than one.
For n_genes == 1: x = that gene, y = zeros.
"""
function _run_direct(
    X::Matrix{Float64},
    gene_names::Vector{Symbol},
    n_genes::Int,
)::Tuple{Union{Matrix{Float64}, Nothing}, Vector{String}, Vector{String}}
    n_cells = size(X, 1)

    if n_genes == 1
        coords = vcat(reshape(X[:, 1], 1, :), zeros(1, n_cells))
        labels = [string(gene_names[1]), "0"]
        return coords, labels, ["", ""]
    end

    # Pick 2 highest-variance columns (covers n_genes == 2 and any edge cases).
    variances = [var(X[:, j]) for j in 1:n_genes]
    order     = sortperm(variances; rev = true)
    j1, j2    = order[1], order[2]
    coords    = vcat(reshape(X[:, j1], 1, :), reshape(X[:, j2], 1, :))
    labels    = [string(gene_names[j1]), string(gene_names[j2])]
    return coords, labels, ["", ""]
end

# ── PCA 2-D ───────────────────────────────────────────────────────────────────

"""
Fit PCA, take the first 2 components.  Returns variance-explained axis labels
and the gene with the highest absolute loading per component.
"""
function _run_pca_2d(
    X::Matrix{Float64},
    gene_names::Vector{Symbol},
    n_cells::Int,
)::Tuple{Union{Matrix{Float64}, Nothing}, Vector{String}, Vector{String}}
    Xt = Matrix{Float64}(X')   # n_genes × n_cells
    mu = vec(mean(Xt; dims = 2))
    Xt .-= mu

    n_components = min(2, size(Xt, 1), n_cells - 1)
    n_components < 2 && return nothing, String[], String[]

    try
        model    = fit(PCA, Xt; maxoutdim = n_components, pratio = 0.9999)
        n_fitted = outdim(model)
        n_fitted >= 1 || return nothing, String[], String[]

        scores   = transform(model, Xt)          # n_fitted × n_cells
        pvar     = principalvars(model) ./ tvar(model) .* 100.0
        loadings = projection(model)             # n_genes × n_fitted

        top_genes   = [string(gene_names[argmax(abs.(loadings[:, k]))]) for k in 1:n_fitted]
        axis_labels = ["PC$(k) ($(round(pvar[k]; digits=1))%)" for k in 1:n_fitted]

        # Pad to 2 dimensions if PCA returned only 1 component
        if n_fitted == 1
            coords = vcat(scores, zeros(1, n_cells))
            push!(axis_labels, "")
            push!(top_genes,   "")
        else
            coords = Matrix{Float64}(scores)     # 2 × n_cells
        end

        return coords, axis_labels, top_genes
    catch e
        @warn "[PhaseSpace] PCA failed" exception = e
        return nothing, String[], String[]
    end
end

# ── PCA → UMAP ───────────────────────────────────────────────────────────────

"""
PCA 50 components → UMAP 2-D.
Axis labels are "UMAP 1" / "UMAP 2"; top genes from the first two PCs.
"""
function _run_pca_umap(
    X::Matrix{Float64},
    gene_names::Vector{Symbol},
    n_cells::Int,
    n_genes::Int,
)::Tuple{Union{Matrix{Float64}, Nothing}, Vector{String}, Vector{String}}
    Xt = Matrix{Float64}(X')
    mu = vec(mean(Xt; dims = 2))
    Xt .-= mu

    n_pca = min(50, n_genes, n_cells - 1)
    try
        pca_model = fit(PCA, Xt; maxoutdim = n_pca, pratio = 0.9999)
        reduced   = transform(pca_model, Xt)      # n_pca × n_cells

        # Top genes from the first 2 PCs for informational labels
        loadings  = projection(pca_model)
        top_genes = [string(gene_names[argmax(abs.(loadings[:, k]))]) for k in 1:min(2, n_pca)]

        n_neighbors = clamp(15, 2, max(2, n_cells - 1))
        result_umap = UMAP.fit(reduced, 2; n_neighbors = n_neighbors)
        raw = result_umap.embedding
        coords = raw isa AbstractMatrix ? Matrix{Float64}(raw) : reduce(hcat, raw)   # 2 × n_cells

        return coords, ["UMAP 1", "UMAP 2"], top_genes
    catch e
        @warn "[PhaseSpace] PCA→UMAP failed" exception = e
        return nothing, String[], String[]
    end
end

# ============================================================================
# Internal: Arrow loading
# ============================================================================

"""
Load protein-species timeseries from Arrow files.

Returns `Dict{Symbol, Dict{String, Vector{Tuple{Float64,Int}}}}`:
  gene → path → [(t, count), ...] sorted by t.

Keys are bare gene names (e.g. `:tetR`, `:1`), derived by stripping the
`.proteins` suffix from the Arrow species name.
"""
function _load_protein_timeseries(
    result_path::String,
)::Dict{Symbol, Dict{String, Vector{Tuple{Float64,Int}}}}
    i_to_path = Dict{Int, String}()
    index_file = joinpath(result_path, "index.arrow")
    if !isfile(index_file)
        @warn "[PhaseSpace] No index.arrow found" result_path
        return Dict{Symbol, Dict{String, Vector{Tuple{Float64,Int}}}}()
    end

    idx_tbl = Arrow.Table(index_file)
    for i in eachindex(idx_tbl.i)
        i_to_path[idx_tbl.i[i]] = string(idx_tbl.path[i])
    end

    temp = Dict{Symbol, Dict{Tuple{String,Int}, Vector{Tuple{Float64,Int}}}}()
    for file in readdir(result_path)
        startswith(file, "events") && endswith(file, ".stream.arrow") || continue
        tbl = Arrow.Table(joinpath(result_path, file))
        for (ep_i, t, name, value) in zip(tbl.i, tbl.t, tbl.name, tbl.value)
            endswith(string(name), ".proteins") || continue
            # Key by bare gene name (strip ".proteins") so downstream code and
            # gene_colours lookups use the same identifier.
            bare_name = Symbol(string(name)[1:end-length(".proteins")])
            path   = get(i_to_path, ep_i, string(ep_i))
            ep_map = get!(temp, bare_name) do
                Dict{Tuple{String,Int}, Vector{Tuple{Float64,Int}}}()
            end
            push!(get!(ep_map, (path, ep_i)) do; Tuple{Float64,Int}[] end, (t, Int(value)))
        end
    end

    # Flatten per-episode into per-path timeseries
    result = Dict{Symbol, Dict{String, Vector{Tuple{Float64,Int}}}}()
    for (name, ep_map) in temp
        path_map = Dict{String, Vector{Tuple{Float64,Int}}}()
        for ((path, _), pts) in ep_map
            append!(get!(path_map, path) do; Tuple{Float64,Int}[] end, pts)
        end
        for pts in values(path_map)
            sort!(pts; by = first)
        end
        result[name] = path_map
    end

    @debug "[PhaseSpace] Protein species loaded" count = length(result)
    return result
end

# ============================================================================
# Internal: expression matrix
# ============================================================================

"""
Sample observation points on a regular time grid, at most `n_per_path` per path.

Collects all unique paths and the overall time range from the data, then
returns `n_per_path` evenly-spaced (path, t) pairs per path.  The step-function
interpolation in `_build_expression_matrix` handles the value lookup.

When the index contains snapshot episodes (`from == to`), those are exact
observation timepoints from a step-based schedule and are used directly.
Otherwise (continuous runs), every recorded event timestamp is used as a cell —
the user is responsible for keeping run sizes manageable via `step:`.
"""
function _collect_cells(
    result_path::String,
    protein_series::Dict{Symbol, Dict{String, Vector{Tuple{Float64,Int}}}},
)::Vector{Tuple{String, Float64}}
    # --- try snapshot cells from index ---
    cells = _collect_snapshot_cells(result_path)
    if !isempty(cells)
        @debug "[PhaseSpace] Using snapshot cells from index" n_cells=length(cells)
        return cells
    end

    # --- fallback: uniform time sampling ---
    @debug "[PhaseSpace] No snapshot episodes; using all event timestamps as cells"
    return _collect_cells_uniform(protein_series)
end

"""Read snapshot episodes (from == to) from index.arrow as exact cell observations.

Only includes snapshots that follow the skip-pattern: a silent run episode
(from < to, count == 0) immediately preceding a snapshot episode (from == to,
count > 0) on the same path, where the silent run's `to` matches the snapshot's
`from`. This excludes instant model adjustments (seed, add) which also have
from == to but are not terminal observations.
"""
function _collect_snapshot_cells(result_path::String)::Vector{Tuple{String, Float64}}
    index_file = joinpath(result_path, "index.arrow")
    isfile(index_file) || return Tuple{String, Float64}[]
    idx_tbl = Arrow.Table(index_file)

    # Build set of (path, t) that end a silent run interval (from < to, count == 0).
    # These are the candidate predecessor episodes for skip-based snapshots.
    silent_run_ends = Set{Tuple{String, Float64}}()
    for i in eachindex(idx_tbl.i)
        f = Float64(idx_tbl.from[i])
        t = Float64(idx_tbl.to[i])
        c = Int(idx_tbl.count[i])
        if f < t - 1e-9 && c == 0
            push!(silent_run_ends, (string(idx_tbl.path[i]), t))
        end
    end

    # Collect snapshots that are the terminal observation of a skip segment.
    cells = Tuple{String, Float64}[]
    for i in eachindex(idx_tbl.i)
        f = Float64(idx_tbl.from[i])
        t = Float64(idx_tbl.to[i])
        c = Int(idx_tbl.count[i])
        path = string(idx_tbl.path[i])
        if abs(f - t) < 1e-9 && c > 0 && (path, t) in silent_run_ends
            push!(cells, (path, t))
        end
    end

    sort!(cells)
    unique!(cells)
    return cells
end

"""Fallback for continuous runs: use every recorded event timestamp as a cell.

Each unique (path, t) in the protein timeseries corresponds to a real observed
system state. The user is responsible for keeping run sizes manageable; no
implicit subsampling is performed.
"""
function _collect_cells_uniform(
    protein_series::Dict{Symbol, Dict{String, Vector{Tuple{Float64,Int}}}},
)::Vector{Tuple{String, Float64}}
    cell_set = Set{Tuple{String, Float64}}()
    for path_map in values(protein_series)
        for (path, pts) in path_map
            for (t, _) in pts
                push!(cell_set, (path, t))
            end
        end
    end
    isempty(cell_set) && return Tuple{String, Float64}[]
    cells = collect(cell_set)
    sort!(cells)
    return cells
end

"""Last recorded value at or before `t` (step-function lookup)."""
function _step_value(ts::Vector{Tuple{Float64,Int}}, t::Float64)::Int
    isempty(ts) && return 0
    idx = searchsortedlast(ts, (t, typemax(Int)); by = first)
    idx == 0 ? 0 : ts[idx][2]
end

"""Build n_cells × n_genes Float64 matrix via step-function interpolation."""
function _build_expression_matrix(
    cells::Vector{Tuple{String, Float64}},
    gene_names::Vector{Symbol},
    protein_series::Dict{Symbol, Dict{String, Vector{Tuple{Float64,Int}}}},
)::Matrix{Float64}
    n_cells = length(cells)
    n_genes = length(gene_names)
    X       = zeros(Float64, n_cells, n_genes)
    for (j, gene) in enumerate(gene_names)
        path_map = get(protein_series, gene, Dict{String, Vector{Tuple{Float64,Int}}}())
        for (i, (path, t)) in enumerate(cells)
            ts = get(path_map, path, Tuple{Float64,Int}[])
            X[i, j] = Float64(_step_value(ts, t))
        end
    end
    return X
end

# ============================================================================
# Internal: colouring
# ============================================================================

"""
Compute per-cell colours.

Strategy:
- If `gene_colours` contains any saturated colours → softmax blend over those
  protein genes (differentiation model).
- Otherwise → colour by execution path using a fixed hue palette.
"""
function _compute_colours(
    X::Matrix{Float64},
    cells::Vector{Tuple{String, Float64}},
    gene_names::Vector{Symbol},
    gene_colours::Dict{String,String},
)::Vector{String}
    coloured_idx = _coloured_gene_indices(gene_names, gene_colours)
    if !isempty(coloured_idx)
        return _softmax_colours(X, gene_names, coloured_idx, gene_colours)
    elseif length(gene_names) == 2
        # No saturated gene colours but exactly 2 genes: softmax with default palette.
        return _softmax_colours_2_default(X)
    else
        return _path_colours(cells)
    end
end

"""
Indices into `gene_names` whose base gene (sans `_protein`) has a
saturated (non-grey) hex colour in `gene_colours`.
"""
function _coloured_gene_indices(
    gene_names::Vector{Symbol},
    gene_colours::Dict{String,String},
)::Vector{Int}
    [j for (j, g) in enumerate(gene_names)
       if _is_saturated(get(gene_colours, replace(string(g), r"_protein$" => ""), "#888888"))]
end

"""
Softmax blend for the 2-gene direct case when no saturated gene colours exist.
Assigns two fixed contrasting colours (warm red / cool blue).
"""
function _softmax_colours_2_default(X::Matrix{Float64})::Vector{String}
    default_rgb = ((0.88, 0.32, 0.32), (0.32, 0.52, 0.88))
    n_cells = size(X, 1)
    result  = Vector{String}(undef, n_cells)
    for i in 1:n_cells
        vals    = X[i, 1:2]
        shifted = vals .- maximum(vals)
        exps    = exp.(shifted)
        w       = exps ./ sum(exps)
        r = w[1] * default_rgb[1][1] + w[2] * default_rgb[2][1]
        g = w[1] * default_rgb[1][2] + w[2] * default_rgb[2][2]
        b = w[1] * default_rgb[1][3] + w[2] * default_rgb[2][3]
        result[i] = _to_hex(r, g, b)
    end
    return result
end

"""Per-cell softmax blend over non-grey gene hex colours."""
function _softmax_colours(
    X::Matrix{Float64},
    gene_names::Vector{Symbol},
    coloured_idx::Vector{Int},
    gene_colours::Dict{String,String},
)::Vector{String}
    rgb = map(coloured_idx) do j
        hex = lstrip(get(gene_colours, replace(string(gene_names[j]), r"_protein$" => ""), "#888888"), '#')
        (parse(Int, hex[1:2]; base=16)/255.0,
         parse(Int, hex[3:4]; base=16)/255.0,
         parse(Int, hex[5:6]; base=16)/255.0)
    end
    n_cells = size(X, 1)
    result  = Vector{String}(undef, n_cells)
    for i in 1:n_cells
        vals    = X[i, coloured_idx]
        shifted = vals .- maximum(vals)
        exps    = exp.(shifted)
        weights = exps ./ sum(exps)
        r = sum(weights[k] * rgb[k][1] for k in eachindex(coloured_idx))
        g = sum(weights[k] * rgb[k][2] for k in eachindex(coloured_idx))
        b = sum(weights[k] * rgb[k][3] for k in eachindex(coloured_idx))
        result[i] = _to_hex(r, g, b)
    end
    return result
end

"""Colour each cell by its execution path using evenly-spaced hues."""
function _path_colours(cells::Vector{Tuple{String, Float64}})::Vector{String}
    unique_paths = unique(first.(cells))
    n = length(unique_paths)
    path_colour = Dict(
        path => _to_hex(
            (cos(2π * (i-1) / n) * 0.25 + 0.75),
            (cos(2π * (i-1) / n - 2π/3) * 0.25 + 0.75),
            (cos(2π * (i-1) / n + 2π/3) * 0.25 + 0.75),
        )
        for (i, path) in enumerate(unique_paths)
    )
    return [path_colour[path] for (path, _) in cells]
end

"""True when hex colour has HSL saturation > 0.05."""
function _is_saturated(hex_colour::String)::Bool
    hex = lstrip(hex_colour, '#')
    length(hex) == 6 || return false
    r = parse(Int, hex[1:2]; base=16) / 255.0
    g = parse(Int, hex[3:4]; base=16) / 255.0
    b = parse(Int, hex[5:6]; base=16) / 255.0
    cmax = max(r, g, b);  cmin = min(r, g, b)
    l    = (cmax + cmin) / 2.0
    denom = 1.0 - abs(2.0 * l - 1.0)
    denom < 1e-6 && return false
    return (cmax - cmin) / denom > 0.05
end

function _to_hex(r::Float64, g::Float64, b::Float64)::String
    ri = round(Int, clamp(r, 0.0, 1.0) * 255)
    gi = round(Int, clamp(g, 0.0, 1.0) * 255)
    bi = round(Int, clamp(b, 0.0, 1.0) * 255)
    string('#',
        lpad(string(ri; base=16), 2, '0'),
        lpad(string(gi; base=16), 2, '0'),
        lpad(string(bi; base=16), 2, '0'))
end

# ============================================================================
# Internal: storage
# ============================================================================

function _store(result_path::String, result::PhaseSpaceResult)
    # Metadata as compact JSON
    meta_file = joinpath(result_path, "phasespace.json")
    meta = Dict(
        "simulation_id"  => result.simulation_id,
        "method"         => result.method,
        "axis_labels"    => result.axis_labels,
        "axis_top_genes" => result.axis_top_genes,
        "n_genes"        => result.n_genes,
        "n_cells"        => result.n_cells,
    )
    open(meta_file, "w") do f; JSON.print(f, meta) end

    # Points as TSV (fixed columns: x, y, path, t, colour)
    tsv_file = joinpath(result_path, "phasespace.tsv")
    open(tsv_file, "w") do f
        println(f, "x\ty\tpath\tt\tcolour")
        for p in result.points
            println(f, p.x, '\t', p.y, '\t', p.path, '\t', p.t, '\t', p.colour)
        end
    end
    @info "[PhaseSpace] Stored result" meta_file tsv_file n_cells = result.n_cells
end

end  # module PhaseSpace
