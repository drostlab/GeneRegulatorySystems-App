"""
    ScheduleVisualization

Converts GRS.jl Schedule objects into frontend-compatible visualisation schemas.
Handles schedule reification, validation, structure tree generation, and
on-demand network extraction.
"""
module ScheduleVisualization

using GeneRegulatorySystems
using GeneRegulatorySystems.Models
using GeneRegulatorySystems.Models: Wrapped, Instant, Label, Descriptions, Differentiation, KroneckerNetworks, RandomDifferentiation
using GeneRegulatorySystems.Models.V1
using GeneRegulatorySystems.Models.Plumbing
using GeneRegulatorySystems.Models.Scheduling
using GeneRegulatorySystems.Models.Scheduling: Primitive, Schedule as GRSSchedule
using ..NetworkRepresentation
using GeneRegulatorySystems.Specifications
using GeneRegulatorySystems.Specifications: Scope, List, Each, Load, Template, Slice, Sequence
using JSON
using Colors

using ..ScheduleBindings: spec_bindings

# ============================================================================
# Exports
# ============================================================================

export Network, UnionNetwork, ModelExclusions, TimelineSegment, ScheduleData, StructureNode
export ReifiedSchedule, ValidationMessage
export reify_schedule, extract_network_for_model_path, extract_union_network, is_valid, get_error_messages
export gene_colours_from_spec

# ============================================================================
# Schema Types
# ============================================================================

@kwdef struct Network
    nodes::Vector{NetworkRepresentation.Node}
    links::Vector{NetworkRepresentation.Link}
end

"""
    UnionLink

Serialised link used by `UnionNetwork`.

Includes a stable, backend-generated `id` so frontend code can match
`model_exclusions.links` without re-implementing Julia-side ID logic.

`parameters` lists the editable parameter slots this link exposes (e.g. Hill
`at`/`k`). The structural shape is identical across models — concrete values
are looked up per active model via `UnionNetwork.parameters_by_model_path`.
"""
@kwdef struct UnionLink
    id::String
    kind::Symbol
    from::Symbol
    to::Symbol
    properties::Dict{Symbol, Any} = Dict{Symbol, Any}()
    parameters::Vector{NetworkRepresentation.Parameter} = NetworkRepresentation.Parameter[]
    scope::Symbol = :all
end

"""
    ModelExclusions

Nodes and links absent from a specific model (relative to the union).
"""
@kwdef struct ModelExclusions
    nodes::Vector{String}
    links::Vector{String}
end

"""
    UnionNetwork

Union of all model networks. `model_exclusions` maps each model_path to the
nodes/links that are NOT present in that model.

`parameters_by_model_path` maps `model_path -> (parameter_symbol -> value)`,
allowing the frontend to render the active model's parameter values without
storing them per-link (which historically caused value-divergent models to
fork the union into duplicate links).
"""
@kwdef struct UnionNetwork
    nodes::Vector{NetworkRepresentation.Node}
    links::Vector{UnionLink}
    model_exclusions::Dict{String, ModelExclusions}
    parameters_by_model_path::Dict{String, Dict{String, Float64}} = Dict{String, Dict{String, Float64}}()
end

"""
    TimelineSegment

Single execution segment from a dryrun pass.

- `id`: auto-increment unique identifier
- `execution_path`: dryrun `path` kwarg (not unique for repeating scopes)
- `model_path`: `primitive!.path` (spec location, used for network loading)
- `json_path`: JSONPath segments for locating the model definition in the source JSON
- `from`/`to`: time range (from == to for instant models)
- `label`: human-readable model label
"""
@kwdef struct TimelineSegment
    id::Int
    execution_path::String
    model_path::String
    json_path::Vector{Any}
    from::Float64
    to::Float64
    label::String
    channel::String
end

"""
    StructureNode

Recursive tree mirroring the schedule specification structure.
Used by the frontend to compute rectangle layout for timeline/promoter charts.

- `type`: `:scope`, `:sequence`, `:branch`, `:leaf`
- `execution_path`: the execution path prefix for this node
- `label`: human-readable label (from spec)
- `children`: child nodes (empty for leaves)
"""
@kwdef struct StructureNode
    type::Symbol
    execution_path::String = ""
    label::String = ""
    children::Vector{StructureNode} = StructureNode[]
end

"""
    ScheduleData

Complete visualisation schema. No network included -- networks are loaded on demand.
"""
@kwdef struct ScheduleData
    segments::Vector{TimelineSegment}
    structure::StructureNode
    genes::Vector{String} = String[]
    gene_colours::Dict{String, String} = Dict{String, String}()
end

# ============================================================================
# API Types
# ============================================================================

@kwdef struct ValidationMessage
    type::String
    content::String
end

"""
    ReifiedSchedule

Loaded schedule with metadata and visualisation data.
"""
@kwdef struct ReifiedSchedule
    name::String
    source::String
    spec::String
    data::Union{ScheduleData, Nothing} = nothing
    validationMessages::Vector{ValidationMessage} = ValidationMessage[]
end

# ============================================================================
# Subfile Includes
# ============================================================================

include("schedule_validation.jl")
include("schedule_structure.jl")
include("gene_colours.jl")
include("network_extraction.jl")

# ============================================================================
# Internal: Spec Parsing
# ============================================================================

"""Parse a spec string into a GRSSchedule."""
function _parse_schedule(spec_string::String)::GRSSchedule
    spec = JSON.parse(spec_string, dicttype=Dict{Symbol, Any})
    bindings = spec_bindings(spec)
    specification = Specifications.Specification(spec; bound = Set(keys(bindings)))
    return GRSSchedule(; specification, bindings)
end

# ============================================================================
# Public API
# ============================================================================

"""
    reify_schedule(spec_string; name, source) -> ReifiedSchedule

Parse, validate, and build visualisation data for a schedule spec string.
"""
function reify_schedule(spec_string::String; name::String="", source::String="snapshot")::ReifiedSchedule
    start_time = time()
    validation_messages = ValidationMessage[]
    visualisation = nothing

    try
        spec = JSON.parse(spec_string, dicttype=Dict{Symbol, Any})

        validation_msgs = _validate_spec(spec)
        append!(validation_messages, validation_msgs)

        has_errors = any(m -> m.type == "error", validation_messages)
        if !has_errors
            @info "Generating schedule visualisation" name source
            vis_start = time()

            grs_schedule = _parse_schedule(spec_string)

            segments, genes, gene_colours = _collect_segments(grs_schedule)
            merge!(gene_colours, _extract_spec_gene_colours(spec))
            merged = _merge_contiguous_segments(segments)
            structure = _build_structure_tree(grs_schedule)

            @info "Schedule visualisation generated" name segments=length(merged) genes=length(genes) elapsed=(time() - vis_start)

            visualisation = ScheduleData(;
                segments = merged,
                structure,
                genes,
                gene_colours,
            )
        end
    catch e
        push!(validation_messages, ValidationMessage(
            type = "error",
            content = "Failed to process schedule: $(string(e))"
        ))
        @error "Schedule processing failed" exception=e
    end

    @info "Schedule load completed" name source valid=!any(m -> m.type == "error", validation_messages) elapsed=(time() - start_time)

    return ReifiedSchedule(; name, source, spec = spec_string, data = visualisation, validationMessages = validation_messages)
end

"""
    extract_network_for_model_path(grs_schedule, model_path) -> Network

Extract the network for a specific model path using `Scheduling.reify`.
"""
function extract_network_for_model_path(grs_schedule::GRSSchedule, model_path::String; include_reactions::Bool=true)::Network
    @debug "Extracting network for model_path" model_path include_reactions
    primitive = Scheduling.reify(grs_schedule, model_path)
    entity = NetworkRepresentation.entity(primitive; include_reactions)
    nodes, links = NetworkRepresentation.flatten(entity)
    return Network(; nodes, links)
end

"""
    extract_network_for_model_path(spec_string, model_path) -> Network

Convenience: parse spec string and extract network.
"""
function extract_network_for_model_path(spec_string::String, model_path::String)::Network
    return extract_network_for_model_path(_parse_schedule(spec_string), model_path)
end

"""
    _extract_model_parameters(grs_schedule, model_path) -> Dict{String, Float64}

Reify the model at `model_path` and return its flat parameter map, with
canonical symbol names as strings (frontend-friendly).
"""
function _extract_model_parameters(grs_schedule::GRSSchedule, model_path::String)::Dict{String, Float64}
    reified = Scheduling.reify(grs_schedule, model_path)
    return Dict(string(k) => Float64(v) for (k, v) in Models.parameters(reified))
end

"""
    extract_union_network(spec_string, segments) -> UnionNetwork

Build the union network across all model paths in the schedule segments.
Each model's exclusions (nodes/links absent from that model) are recorded.
Per-model parameter values are returned in `parameters_by_model_path`.
"""
function extract_union_network(spec_string::String, segments::Vector{TimelineSegment}; include_reactions::Bool=true)::UnionNetwork
    grs_schedule = _parse_schedule(spec_string)

    model_paths = _unique_model_paths(segments)
    per_model = Dict{String, Network}()
    parameters_by_model_path = Dict{String, Dict{String, Float64}}()
    for mp in model_paths
        try
            per_model[mp] = extract_network_for_model_path(grs_schedule, mp; include_reactions)
        catch e
            @warn "Could not extract network for model_path" model_path=mp exception=e
        end
        try
            parameters_by_model_path[mp] = _extract_model_parameters(grs_schedule, mp)
        catch e
            @warn "Could not extract parameters for model_path" model_path=mp exception=e
            parameters_by_model_path[mp] = Dict{String, Float64}()
        end
    end

    # Build union. Link identity is topological (see `_link_id`); the
    # `parameters` slot list is structural and identical across models, so we
    # take it from whichever model contributed each link.
    all_nodes = Dict{String, NetworkRepresentation.Node}()
    all_links = Dict{String, UnionLink}()
    for (_, net) in per_model
        for n in net.nodes
            all_nodes[string(n.name)] = n
        end
        for l in net.links
            id = _link_id(l)
            haskey(all_links, id) && continue
            all_links[id] = UnionLink(
                id = id,
                kind = l.kind,
                from = l.from,
                to = l.to,
                properties = l.properties,
                parameters = l.parameters,
                scope = l.scope,
            )
        end
    end

    union_node_names = Set(keys(all_nodes))
    union_link_ids = Set(keys(all_links))

    model_exclusions = Dict{String, ModelExclusions}()
    for (mp, net) in per_model
        model_node_names = Set(string(n.name) for n in net.nodes)
        model_link_ids = Set(_link_id(l) for l in net.links)
        model_exclusions[mp] = ModelExclusions(
            nodes = collect(setdiff(union_node_names, model_node_names)),
            links = collect(setdiff(union_link_ids, model_link_ids)),
        )
    end

    @info "Union network built" nodes=length(all_nodes) links=length(all_links) models=length(per_model)
    return UnionNetwork(
        nodes = collect(values(all_nodes)),
        links = collect(values(all_links)),
        model_exclusions = model_exclusions,
        parameters_by_model_path = parameters_by_model_path,
    )
end

"""
    gene_colours_from_spec(spec_string) -> Dict{String, String}

Dry-run the schedule and return the gene-colour mapping (gene name -> hex colour)
used for visualisation. Lightweight alternative to `reify_schedule` when only
gene colours are needed (e.g. for dim-reduction colouring).
"""
function gene_colours_from_spec(spec_string::String)::Dict{String, String}
    (_, _, gene_colours) = _collect_segments(_parse_schedule(spec_string))
    spec = JSON.parse(spec_string, dicttype=Dict{Symbol, Any})
    merge!(gene_colours, _extract_spec_gene_colours(spec))
    return gene_colours
end

# ============================================================================
# Convenience Queries
# ============================================================================

is_valid(reified::ReifiedSchedule)::Bool = !any(msg -> msg.type == "error", reified.validationMessages)

function get_error_messages(reified::ReifiedSchedule)::String
    error_msgs = filter(msg -> msg.type == "error", reified.validationMessages)
    return join([msg.content for msg in error_msgs], "; ")
end

end # module ScheduleVisualization
