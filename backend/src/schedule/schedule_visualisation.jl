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

export Network, UnionNetwork, ModelExclusions, TimelineSegment, ScheduleData
export ReifiedSchedule, ValidationMessage
export reify_schedule, extract_network_for_model_path, extract_union_network, is_valid, get_error_messages
export gene_colours_from_spec, clear_spec_cache

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
- `model_type`: the unwrapped GRS model's type name (e.g. `"Adjust"`); the frontend
  maps this to a glyph. Instant-ness is carried by `from == to`, not `model_type`.
- `label`: human-readable model label
"""
@kwdef struct TimelineSegment
    id::Int
    execution_path::String
    model_path::String
    json_path::Vector{Any}
    from::Float64
    to::Float64
    model_type::String
    label::String
end

"""
    ScheduleData

Complete visualisation schema. No network included -- networks are loaded on demand.
The schedule topology is reconstructed on the frontend by parsing each segment's
`execution_path` on the `+ - / .` grammar.
"""
@kwdef struct ScheduleData
    segments::Vector{TimelineSegment}
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
# Spec Cache (LRU keyed by hash(spec_string))
#
# Three independent products are memoised per spec:
#   - the parsed `GRSSchedule`
#   - the `ScheduleData` + validation messages produced by `reify_schedule`
#   - the `UnionNetwork` produced by `extract_union_network`
#
# Each is filled lazily on first request. The server is single-user, so
# locking covers only dict bookkeeping; expensive work runs outside the lock.
# ============================================================================

mutable struct SpecCacheEntry
    grs_schedule::GRSSchedule
    schedule_data::Union{ScheduleData, Nothing}
    validation_messages::Union{Vector{ValidationMessage}, Nothing}
    union_network::Union{UnionNetwork, Nothing}
end

const SPEC_CACHE_MAX = 16
const SPEC_CACHE = Dict{UInt64, SpecCacheEntry}()
const SPEC_CACHE_LRU = UInt64[]
const SPEC_CACHE_LOCK = ReentrantLock()

function touch_lru!(h::UInt64)
    i = findfirst(==(h), SPEC_CACHE_LRU)
    i === nothing || deleteat!(SPEC_CACHE_LRU, i)
    push!(SPEC_CACHE_LRU, h)
end

function cache_entry(spec_string::AbstractString)::SpecCacheEntry
    h = hash(spec_string)
    lock(SPEC_CACHE_LOCK) do
        existing = get(SPEC_CACHE, h, nothing)
        if existing !== nothing
            touch_lru!(h)
            return existing
        end
        entry = SpecCacheEntry(_parse_schedule(String(spec_string)), nothing, nothing, nothing)
        SPEC_CACHE[h] = entry
        touch_lru!(h)
        while length(SPEC_CACHE_LRU) > SPEC_CACHE_MAX
            evict = popfirst!(SPEC_CACHE_LRU)
            delete!(SPEC_CACHE, evict)
        end
        return entry
    end
end

function clear_spec_cache()
    lock(SPEC_CACHE_LOCK) do
        empty!(SPEC_CACHE)
        empty!(SPEC_CACHE_LRU)
    end
end

# ============================================================================
# Public API
# ============================================================================

"""
    reify_schedule(spec_string; name, source) -> ReifiedSchedule

Parse, validate, and build visualisation data for a schedule spec string.
Heavy work is memoised per spec; `name`/`source` are attached per request.
"""
function reify_schedule(spec_string::String; name::String="", source::String="snapshot")::ReifiedSchedule
    start_time = time()
    entry = try
        cache_entry(spec_string)
    catch e
        @error "Schedule parse failed" exception=(e, catch_backtrace())
        msgs = [ValidationMessage(type="error", content=schedule_error_message(e))]
        return ReifiedSchedule(; name, source, spec=spec_string, data=nothing, validationMessages=msgs)
    end

    if entry.validation_messages === nothing
        fill_schedule_data!(entry, spec_string, name, source)
    end

    @info "Schedule load completed" name source valid=!any(m -> m.type == "error", entry.validation_messages) elapsed=(time() - start_time)

    return ReifiedSchedule(;
        name, source,
        spec = spec_string,
        data = entry.schedule_data,
        validationMessages = entry.validation_messages,
    )
end

function fill_schedule_data!(entry::SpecCacheEntry, spec_string::String, name::String, source::String)
    msgs = ValidationMessage[]
    data = nothing
    try
        spec = JSON.parse(spec_string, dicttype=Dict{Symbol, Any})
        append!(msgs, _validate_spec(spec))
        if !any(m -> m.type == "error", msgs)
            @info "Generating schedule visualisation" name source
            vis_start = time()
            segments, genes, gene_colours = _collect_segments(entry.grs_schedule)
            merge!(gene_colours, _extract_spec_gene_colours(spec))
            merged = _merge_contiguous_segments(segments)
            data = ScheduleData(; segments=merged, genes, gene_colours)
            @info "Schedule visualisation generated" name segments=length(merged) genes=length(genes) elapsed=(time() - vis_start)
        end
    catch e
        push!(msgs, ValidationMessage(type="error", content=schedule_error_message(e)))
        @error "Schedule processing failed" exception=(e, catch_backtrace())
    end
    entry.schedule_data = data
    entry.validation_messages = msgs
end

"""
    extract_network_for_model_path(grs_schedule, model_path) -> Network

Extract the network for a specific model path using `Scheduling.reify`.
"""
function extract_network_for_model_path(grs_schedule::GRSSchedule, model_path::String; include_reactions::Bool=true)::Network
    @debug "Extracting network for model_path" model_path include_reactions
    return network_from_reified(Scheduling.reify(grs_schedule, model_path); include_reactions)
end

"""
    extract_network_for_model_path(spec_string, model_path) -> Network

Convenience: parse spec string and extract network.
"""
function extract_network_for_model_path(spec_string::String, model_path::String)::Network
    return extract_network_for_model_path(cache_entry(spec_string).grs_schedule, model_path)
end

function network_from_reified(reified; include_reactions::Bool=true)::Network
    entity = NetworkRepresentation.entity(reified; include_reactions)
    nodes, links = NetworkRepresentation.flatten(entity)
    return Network(; nodes, links)
end

# `NetworkRepresentation.parameter_defaults` unwraps the reified model
# (Primitive → Wrapped → Definition) via the same dispatch ladder as
# `entity`, then reads its v1 parameter defaults. Non-v1 models yield an
# empty dict (no chips).
function params_from_reified(reified)::Dict{String, Float64}
    return Dict(string(k) => Float64(v)
                for (k, v) in NetworkRepresentation.parameter_defaults(reified))
end

"""
    extract_union_network(spec_string, segments) -> UnionNetwork

Build the union network across all model paths. Each model is reified exactly
once; the resulting `UnionNetwork` is memoised per spec.
"""
function extract_union_network(spec_string::String, segments::Vector{TimelineSegment}; include_reactions::Bool=true)::UnionNetwork
    entry = cache_entry(spec_string)
    entry.union_network === nothing || return entry.union_network

    model_paths = _unique_model_paths(segments)
    per_model = Dict{String, Network}()
    parameters_by_model_path = Dict{String, Dict{String, Float64}}()
    for mp in model_paths
        try
            reified = Scheduling.reify(entry.grs_schedule, mp)
            per_model[mp] = network_from_reified(reified; include_reactions)
            parameters_by_model_path[mp] = params_from_reified(reified)
        catch e
            @warn "Could not extract for model_path" model_path=mp exception=e
            parameters_by_model_path[mp] = get(parameters_by_model_path, mp, Dict{String, Float64}())
        end
    end

    union_net = build_union(per_model, parameters_by_model_path)
    entry.union_network = union_net
    @info "Union network built" nodes=length(union_net.nodes) links=length(union_net.links) models=length(per_model)
    return union_net
end

# Link identity is topological (see `_link_id`); the `parameters` slot list is
# structural and identical across models, so we take it from whichever model
# contributed each link first.
function build_union(per_model::Dict{String, Network}, parameters_by_model_path::Dict{String, Dict{String, Float64}})::UnionNetwork
    all_nodes = Dict{String, NetworkRepresentation.Node}()
    all_links = Dict{String, UnionLink}()
    for net in values(per_model)
        for n in net.nodes
            all_nodes[string(n.name)] = n
        end
        for l in net.links
            id = _link_id(l)
            haskey(all_links, id) && continue
            all_links[id] = UnionLink(;
                id, kind=l.kind, from=l.from, to=l.to,
                properties=l.properties, parameters=l.parameters, scope=l.scope,
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

    return UnionNetwork(;
        nodes = collect(values(all_nodes)),
        links = collect(values(all_links)),
        model_exclusions,
        parameters_by_model_path,
    )
end

"""
    gene_colours_from_spec(spec_string) -> Dict{String, String}

Return the gene-colour mapping used for visualisation. Reuses the cached
schedule data when present; otherwise triggers a lazy fill.
"""
function gene_colours_from_spec(spec_string::String)::Dict{String, String}
    reified = reify_schedule(spec_string)
    return reified.data === nothing ? Dict{String, String}() : reified.data.gene_colours
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
