# ============================================================================
# Gene Name Extraction + Colour Generation
# ============================================================================

using GeneRegulatorySystems.Models
using GeneRegulatorySystems.Models: Wrapped, Differentiation, KroneckerNetworks, RandomDifferentiation
using GeneRegulatorySystems.Models.V1
using GeneRegulatorySystems.Models.Scheduling: Primitive
using Colors
using JSON

# ============================================================================
# Gene Name Extraction
# ============================================================================

# Lightweight gene name extraction via multiple dispatch.
# Descends through Wrapped layers to find V1.Definition without building networks.
_gene_names(primitive::Primitive) = _gene_names(primitive.f!)
_gene_names(wrapped::Wrapped) = _gene_names(wrapped.definition, wrapped)
_gene_names(::V1.Definition, wrapped::Wrapped) = Symbol[g.name for g in wrapped.definition.genes]
_gene_names(_, wrapped::Wrapped) = _gene_names(wrapped.model)
_gene_names(_) = Symbol[]

# ============================================================================
# Colour Helpers
# ============================================================================

_hsl_hex(h::Float64, s::Float64, l::Float64)::String =
    "#$(hex(convert(RGB, HSL(h, s, l))))"

# ============================================================================
# Basic Colour Schemes
# ============================================================================

"""Maximally-distinct pastel colours for a plain list of gene names."""
function _generate_gene_colours(gene_names::Vector{String})::Dict{String, String}
    isempty(gene_names) && return Dict{String, String}()
    seed = [colorant"white", colorant"black", colorant"crimson", colorant"green"]
    colors = distinguishable_colors(length(gene_names), seed, dropseed = true)
    colors = [let hsv = HSV(c); HSV(hsv.h, hsv.s * 0.65, min(hsv.v * 1.8, 1.0)) end for c in colors]
    colors = convert.(RGB, colors)
    return Dict(string(gene) => "#$(hex(colors[i]))" for (i, gene) in enumerate(gene_names))
end

"""Evenly-spaced gray shades for Kronecker/peripheral genes."""
function _gray_colours(gene_names::Vector{String})::Dict{String, String}
    isempty(gene_names) && return Dict{String, String}()
    n = length(gene_names)
    return Dict(
        name => _hsl_hex(0.0, 0.0, 0.62 - 0.20 * (i - 1) / max(1, n - 1))
        for (i, name) in enumerate(gene_names)
    )
end

# ============================================================================
# Differentiation Tree Colouring
# ============================================================================

# Top-down arc-splitting: the root owns a centre hue and a total arc.
# Each level splits the arc in half and assigns left/right children to the
# two sub-centres. Saturation and lightness scale up with depth.

_diff_gene_name(g::V1.Gene)::Symbol = g.name
_diff_gene_name(s::Symbol)::Symbol  = s

const _DIFF_HUE_CENTER      = 220.0
const _DIFF_HUE_INITIAL_ARC = 100.0

_diff_saturation(depth::Int)::Float64 = clamp(0.18 + depth * 0.14, 0.18, 0.78)
_diff_lightness(depth::Int)::Float64  = clamp(0.30 + depth * 0.08, 0.30, 0.64)

function _assign_diff_colours!(
    t::Differentiation.Transient,
    centre::Float64,
    half_arc::Float64,
    depth::Int,
    colours::Dict{String, String},
)
    hue = mod(centre, 360.0)
    s   = _diff_saturation(depth)
    l   = _diff_lightness(depth)
    colours[string(_diff_gene_name(t.differentiator))] = _hsl_hex(hue, s, l)
    timer_name = Symbol(string(_diff_gene_name(t.differentiator)) * "_timer")
    colours[string(timer_name)] = _hsl_hex(hue, max(s - 0.12, 0.08), min(l + 0.18, 0.82))
    child_half = half_arc / 2.0
    _assign_diff_child!(t.next,        centre - half_arc / 2.0, child_half, depth + 1, colours)
    _assign_diff_child!(t.alternative, centre + half_arc / 2.0, child_half, depth + 1, colours)
end

_assign_diff_child!(t::Differentiation.Transient, centre, half_arc, depth, colours) =
    _assign_diff_colours!(t, centre, half_arc, depth, colours)

function _assign_diff_child!(g::V1.Gene, centre, _, depth, colours)
    colours[string(g.name)] = _hsl_hex(mod(centre, 360.0), _diff_saturation(depth), _diff_lightness(depth))
end

function _assign_diff_child!(sym::Symbol, centre, _, depth, colours)
    colours[string(sym)] = _hsl_hex(mod(centre, 360.0), _diff_saturation(depth), _diff_lightness(depth))
end

"""Colours for a fully-instantiated Differentiation.Definition."""
function _diff_colours(def::Differentiation.Definition)::Dict{String, String}
    colours = Dict{String, String}()
    _assign_diff_colours!(def.differentiation, _DIFF_HUE_CENTER, _DIFF_HUE_INITIAL_ARC, 0, colours)
    peripheral_names = String[string(g.name) for g in def.peripheral.genes]
    merge!(colours, _gray_colours(peripheral_names))
    return colours
end

# ============================================================================
# Per-model Dispatch
# ============================================================================

_gene_colours(primitive::Primitive)             = _gene_colours(primitive.f!)
_gene_colours(wrapped::Wrapped)                 = _gene_colours(wrapped.definition, wrapped)

function _gene_colours(::RandomDifferentiation.Definition, wrapped::Wrapped)
    _diff_colours(wrapped.model.definition)
end

function _gene_colours(::KroneckerNetworks.Definition, wrapped::Wrapped)
    gene_names = String[string(g.name) for g in wrapped.model.definition.genes]
    _gray_colours(gene_names)
end

function _gene_colours(def::V1.Definition, ::Wrapped)
    gene_names = String[string(g.name) for g in def.genes]
    return _generate_gene_colours(gene_names)
end

_gene_colours(_, wrapped::Wrapped) = _gene_colours(wrapped.model)
_gene_colours(_)                   = Dict{String, String}()

# ============================================================================
# JSON Spec Colour Extraction (hack for public package lacking Gene.color)
# ============================================================================

"""
Recursively walk a parsed JSON spec to find all `{regulation/v1}` blocks
and extract any `"color"` fields from their gene objects.
Returns a Dict mapping gene name (String) => colour hex (String).
"""
function _extract_spec_gene_colours(spec)::Dict{String, String}
    colours = Dict{String, String}()
    _walk_spec_for_colours!(colours, spec)
    return colours
end

function _walk_spec_for_colours!(colours::Dict{String, String}, node::Dict)
    reg_key = Symbol("{regulation/v1}")
    if haskey(node, reg_key)
        _extract_v1_gene_colours!(colours, node[reg_key])
    end
    for (_, v) in node
        _walk_spec_for_colours!(colours, v)
    end
end

function _walk_spec_for_colours!(colours::Dict{String, String}, node::Vector)
    for item in node
        _walk_spec_for_colours!(colours, item)
    end
end

_walk_spec_for_colours!(::Dict{String, String}, _) = nothing

function _extract_v1_gene_colours!(colours::Dict{String, String}, reg::Dict)
    genes_key = Symbol("genes")
    haskey(reg, genes_key) || return
    genes = reg[genes_key]
    genes isa Vector || return
    for (i, gene) in enumerate(genes)
        gene isa Dict || continue
        color_key = Symbol("color")
        haskey(gene, color_key) || continue
        color_val = gene[color_key]
        color_val isa AbstractString || continue
        # Gene name: use explicit "name" field if present, otherwise 1-indexed number
        name_key = Symbol("name")
        gene_name = haskey(gene, name_key) ? string(gene[name_key]) : string(i)
        colours[gene_name] = string(color_val)
    end
end
