module NetworkRepresentation

using Catalyst

using GeneRegulatorySystems.Models
using GeneRegulatorySystems.Models: Wrapped, Instant
using GeneRegulatorySystems.Models.V1
using GeneRegulatorySystems.Models.Differentiation
using GeneRegulatorySystems.Models.KroneckerNetworks
using GeneRegulatorySystems.Models.RandomDifferentiation
using GeneRegulatorySystems.Models.Scheduling: Primitive
using GeneRegulatorySystems.Models.SciML: normalize_name
using GeneRegulatorySystems.Specifications

# TODO: move each method to the model module it belongs to


"""
    Parameter

An editable kinetic parameter associated with a network element.

- `name`: human-readable label shown in the UI (e.g. `"at"`, `"k"`, `"rate"`).
- `symbol`: canonical model-parameter symbol used by `Models.parameters` /
  `Models.remake` (e.g. `"gene_1.repression.gene_3.at"`,
  `"gene_1.transcription"`).

Values are not stored here — they are looked up per active model via the
`parameters_by_model_path` map on the union network.
"""
@kwdef struct Parameter
    name::String
    symbol::String
end

# TODO: maybe we can represent reaction nodes as hyperlinks instead of nodes? think that would make more sense?
"""
    Link

Directed edge in the network graph.

- `scope`: `:all` (visible at both zoom levels), `:gene` (zoomed-out only),
  `:species` (zoomed-in only). The frontend resolves endpoints to gene parents
  when zoomed out for `:all`-scoped edges.
- `parameters`: editable kinetic parameters this link exposes (e.g. Hill `at`
  and `k` for regulatory links). Values resolved per active model.
"""
@kwdef struct Link
    kind::Symbol
    from::Symbol
    to::Symbol
    properties::Dict{Symbol, Any} = Dict{Symbol, Any}()
    parameters::Vector{Parameter} = Parameter[]
    scope::Symbol = :all
end
#kinds: substrate, product, activation, repression, proteolysis, produces, next, alternative
#scopes: all, gene, species

@kwdef struct Entity
    kind::Symbol
    name::Symbol
    properties::Dict{Symbol, Any} = Dict{Symbol, Any}()
    parameters::Vector{Parameter} = Parameter[]
    nodes::Vector{Entity} = Entity[]
    links::Vector{Link} = Link[]
end
#kinds: species, reaction, reaction_system, gene, v1_model, differentiation_core, kronecker_network

function node_lookup(entity::Entity)::Dict{Symbol, Entity}
    Dict(node.name => node for node in entity.nodes)
end

function strip_time(s::Symbol)
    return Symbol(replace(String(s), r"\(t\)$" => ""))
end

struct SpeciesId
    name::Symbol
end

function SpeciesId(s::SymbolicUtils.BasicSymbolic)
    SpeciesId(strip_time(normalize_name(s)))
end

function species_components(name::Symbol)
    parts = split(String(name), '.')
    if length(parts) == 1
        return (parent=nothing, species_type=parts[1])
    else
        return (parent=Symbol(parts[1]), species_type=parts[2])
    end
end

parent(name::Symbol) = species_components(name).parent

"""Whether `name` is in `gene_set` directly, or is a species of a gene in the set."""
function _belongs_to_gene_set(name::Symbol, gene_set::Set{Symbol})::Bool
    name ∈ gene_set && return true
    p = parent(name)
    p !== nothing && p ∈ gene_set
end

entity(species::SpeciesId) = let comps = species_components(species.name)
    Entity(
        kind=:species,
        name=species.name,
        properties=Dict(:species_type => comps.species_type)
    )
end

function entity(rs::ReactionSystem, filter_ids::Set{Symbol};
                species_genes::Union{Nothing, Set{Symbol}}=nothing)
    # Build species nodes, filtering by parent gene when species_genes given.
    # Parentless species (machinery: polymerases, ribosomes, proteasomes) are
    # always included so reactions that reference them aren't excluded.
    species_ids = SpeciesId[]
    for s in Catalyst.species(rs)
        sid = SpeciesId(s)
        if species_genes !== nothing
            p = parent(sid.name)
            p !== nothing && p ∉ species_genes && continue
        end
        push!(species_ids, sid)
    end

    nodes = Entity[entity(sid) for sid in species_ids]
    included_names = species_genes !== nothing ? Set{Symbol}(sid.name for sid in species_ids) : nothing

    links = Link[]
    for rxn in Catalyst.reactions(rs)
        # In filtered mode, keep reactions that involve at least one species
        # belonging to a core gene (parentless machinery species don't count).
        if included_names !== nothing
            has_core = false
            for s in rxn.substrates
                id = SpeciesId(s).name
                if id ∈ included_names && parent(id) !== nothing
                    has_core = true; break
                end
            end
            if !has_core
                for p in rxn.products
                    id = SpeciesId(p).name
                    if id ∈ included_names && parent(id) !== nothing
                        has_core = true; break
                    end
                end
            end
            has_core || continue
        end

        rxn_name = _reaction_id(rxn)
        rxn_name in filter_ids && continue

        # For cascade and auxiliary reactions `rxn.rate` is a single MTK
        # parameter whose canonical name (e.g. `gene_1.transcription`,
        # `reaction.0.k⁺`) is exactly what `Models.parameters` keys by.
        # Regulatory reactions (e.g. V1's `active<->inactive` for non-unique
        # genes) carry a composite rate expression where `normalize_name`
        # would fail — keep the reaction node and its substrate/product edges
        # but omit the editable rate parameter in that case.
        props = Dict{Symbol, Any}()
        params = Parameter[]
        try
            rate_sym = string(normalize_name(rxn.rate))
            props[:rate] = Symbol(rate_sym)
            push!(params, Parameter(name="rate", symbol=rate_sym))
        catch
            # Composite rate; no single parameter to expose.
        end
        push!(nodes, Entity(
            kind=:reaction, name=rxn_name,
            properties=props,
            parameters=params,
        ))

        append!(links,
            [Link(kind=:substrate, from=SpeciesId(s).name, to=rxn_name, properties=Dict(:stoichiometry => rxn.substoich[i]))
             for (i,s) in enumerate(rxn.substrates)]
        )
        append!(links,
            [Link(kind=:product, from=rxn_name, to=SpeciesId(p).name, properties=Dict(:stoichiometry => rxn.prodstoich[i]))
             for (i,p) in enumerate(rxn.products)]
        )
    end

    Entity(kind=:reaction_system,
           name=:reaction_system,
           nodes=nodes,
           links=links)
end

"""
    _regulatory_reaction_ids(definition, raw_links) -> Set{Symbol}

Derive the exact Catalyst reaction IDs that are implementation artifacts of
V1's regulation pipeline, so they can be excluded from the network graph
(their rates are composite expressions, not single parameters, and don't
correspond to "real" reaction nodes).

- **Activation/deactivation pair**: V1 emits one per *gene*. For `unique`
  genes the Catalyst IDs are `[1]B.active->` and `->[1]B.active` —
  degenerate reactions into/out of nothing, filtered out. Non-unique
  genes get real `[1]B.active->[1]B.inactive` and reverse reactions
  between two species; those are NOT filtered (kept as reaction nodes
  with substrate/product links). Their rates are composite expressions,
  which `entity(::ReactionSystem)` handles by omitting the rate parameter.
- **Proteolysis**: only emitted when a proteolysis link exists. IDs are
  `[1]A.proteins;[1]B.proteins->[1]A.proteins` (cross-gene) or
  `[2]A.proteins->[1]A.proteins` (self-loop).
"""
function _regulatory_reaction_ids(definition::V1.Definition, raw_links)::Set{Symbol}
    ids = Set{Symbol}()

    # For `unique` genes V1 emits degenerate `active->` and `->active`
    # reactions (into/out of nothing) — filter these out. Non-unique genes
    # get real `active<->inactive` transitions; those are kept as reaction
    # nodes (`entity(::ReactionSystem)` tolerates their composite rates).
    for g in definition.genes
        g.unique || continue
        to = g.name
        push!(ids, Symbol("[1]$(to).active->"))
        push!(ids, Symbol("->[1]$(to).active"))
    end

    # Proteolysis: one Catalyst reaction per declared link.
    for lnk in raw_links
        lnk.kind == :proteolysis || continue
        from, to = lnk.from, lnk.to
        if from == to
            push!(ids, Symbol("[2]$(to).proteins->[1]$(to).proteins"))
        else
            push!(ids, Symbol("[1]$(from).proteins;[1]$(to).proteins->[1]$(from).proteins"))
        end
    end

    ids
end

"""
    _attach_v1_transition_rates!(rs_network, definition)

V1's non-unique `active<->inactive` reactions have composite (regulator-
tempered) rates, so `entity(::ReactionSystem)` couldn't extract a single
parameter symbol and left them without a `:rate` property. The base rate
is a real per-gene MTK parameter (`<gene>.activation` / `<gene>.deactivation`),
so we patch it in here — gives the reaction node a label and an editable
parameter chip, just like cascade reactions.
"""
function _attach_v1_transition_rates!(rs_network::Entity, definition::V1.Definition)
    for g in definition.genes
        g.unique && continue
        deact_id = Symbol("[1]$(g.name).active->[1]$(g.name).inactive")
        act_id   = Symbol("[1]$(g.name).inactive->[1]$(g.name).active")
        deact_rate = string(V1.parameter_name(g.name, :deactivation))
        act_rate   = string(V1.parameter_name(g.name, :activation))
        for node in rs_network.nodes
            node.kind == :reaction || continue
            if node.name == deact_id
                node.properties[:rate] = Symbol(deact_rate)
                push!(node.parameters, Parameter(name="rate", symbol=deact_rate))
            elseif node.name == act_id
                node.properties[:rate] = Symbol(act_rate)
                push!(node.parameters, Parameter(name="rate", symbol=act_rate))
            end
        end
    end
end

"""
Generate a deterministic reaction ID from substrates and products.
Format: [stoich]species;[stoich]species->[stoich]species;[stoich]species
Example: [2]1.mRNA;[1]1.protein->[1]1.mRNA;[2]1.protein
"""
function _reaction_id(rxn::Reaction)::Symbol
    substrates = [
        string("[", rxn.substoich[i], "]", SpeciesId(s).name)
        for (i, s) in enumerate(rxn.substrates)
    ]
    products = [
        string("[", rxn.prodstoich[i], "]", SpeciesId(p).name)
        for (i, p) in enumerate(rxn.products)
    ]
    return Symbol(join(substrates, ";") * "->" * join(products, ";"))
end

"""
    _genes_from_reaction_network(rs_network) -> (genes, aux_nodes, aux_links, summary_links)

Partition species and reaction nodes from a reaction system into gene groups.

1. Species with a dotted name (e.g. `A.proteins`) get parent from the prefix.
2. Orphan species whose producing reactions draw ALL substrates from ONE gene
   are adopted by that gene (e.g. homodimer `AA` from `A+A`).
3. Reactions connecting species of a single gene are placed inside that gene.
4. Cross-gene orphan products get `produces` summary links (scope=:gene)
   from each contributing gene, for the zoomed-out view.
5. Intra-gene substrate/product links are tagged scope=:species.
"""
function _genes_from_reaction_network(rs_network::Entity)::Tuple{Vector{Entity}, Vector{Entity}, Vector{Link}, Vector{Link}}

    species_nodes = [n for n in rs_network.nodes if n.kind == :species]
    reaction_nodes = [n for n in rs_network.nodes if n.kind == :reaction]

    # Initial parent assignment from dotted names (e.g. A.proteins -> parent A)
    parent_dict = Dict(s.name => parent(s.name) for s in species_nodes)

    # Index links by endpoint for fast lookup
    links_by_to = Dict{Symbol, Vector{Link}}()
    links_by_from = Dict{Symbol, Vector{Link}}()
    for link in rs_network.links
        push!(get!(links_by_to, link.to, Link[]), link)
        push!(get!(links_by_from, link.from, Link[]), link)
    end

    # Second pass: adopt orphan species produced by single-gene reactions.
    # If ALL substrates of a reaction producing an orphan species belong to
    # the same gene, assign the orphan species to that gene.
    for s in species_nodes
        !isnothing(parent_dict[s.name]) && continue  # already parented

        # Find reactions that produce this species
        producing_reactions = [link.from for link in get(links_by_to, s.name, Link[])
                               if link.kind == :product]
        isempty(producing_reactions) && continue

        # Collect genes of ALL substrates across all producing reactions
        substrate_genes = Set{Symbol}()
        for rxn_name in producing_reactions
            for sub_link in get(links_by_to, rxn_name, Link[])
                sub_link.kind == :substrate || continue
                sub_parent = get(parent_dict, sub_link.from, nothing)
                !isnothing(sub_parent) && push!(substrate_genes, sub_parent)
            end
        end

        # Adopt only if all substrates come from a single gene
        if length(substrate_genes) == 1
            parent_dict[s.name] = first(substrate_genes)
        end
    end

    # Assign reaction parents: single-gene if all connected species share one gene
    for r in reaction_nodes
        connected_parents = Set{Symbol}()
        for link in get(links_by_to, r.name, Link[])
            p = get(parent_dict, link.from, nothing)
            !isnothing(p) && push!(connected_parents, p)
        end
        for link in get(links_by_from, r.name, Link[])
            p = get(parent_dict, link.to, nothing)
            !isnothing(p) && push!(connected_parents, p)
        end
        parent_dict[r.name] = length(connected_parents) == 1 ? first(connected_parents) : nothing
    end

    # Group nodes by parent
    nodes_by_parent = Dict{Union{Symbol, Nothing}, Vector{Entity}}()
    for node in vcat(species_nodes, reaction_nodes)
        push!(get!(nodes_by_parent, parent_dict[node.name], Entity[]), node)
    end

    # Group intra-gene links (scope=:species) and collect cross-gene links
    links_by_parent = Dict{Union{Symbol, Nothing}, Vector{Link}}()
    for link in rs_network.links
        from_p = get(parent_dict, link.from, nothing)
        to_p = get(parent_dict, link.to, nothing)
        if from_p == to_p && !isnothing(from_p)
            tagged = Link(; kind=link.kind, from=link.from, to=link.to,
                           properties=link.properties, scope=:species)
            push!(get!(links_by_parent, from_p, Link[]), tagged)
        end
    end

    # Build gene entities
    genes = [Entity(kind=:gene, name=k,
                    nodes=get(nodes_by_parent, k, Entity[]),
                    links=get(links_by_parent, k, Link[]))
             for k in keys(nodes_by_parent) if !isnothing(k)]

    # Tag cross-gene substrate/product links as scope=:species
    aux_links = Link[]
    for link in rs_network.links
        from_p = get(parent_dict, link.from, nothing)
        to_p = get(parent_dict, link.to, nothing)
        (from_p == to_p && !isnothing(from_p)) && continue  # already in gene
        push!(aux_links, Link(; kind=link.kind, from=link.from, to=link.to,
                               properties=link.properties, scope=:species))
    end

    # Generate summary `produces` links (scope=:gene) for orphan species.
    # These show gene-to-orphan connections when zoomed out.
    summary_links = Link[]
    gene_names = Set(k for k in keys(nodes_by_parent) if !isnothing(k))
    for s in species_nodes
        !isnothing(parent_dict[s.name]) && continue  # not orphan

        # Find contributing genes via substrate parents of producing reactions
        contributing_genes = Set{Symbol}()
        for prod_link in get(links_by_to, s.name, Link[])
            prod_link.kind == :product || continue
            for sub_link in get(links_by_to, prod_link.from, Link[])
                sub_link.kind == :substrate || continue
                sub_parent = get(parent_dict, sub_link.from, nothing)
                !isnothing(sub_parent) && push!(contributing_genes, sub_parent)
            end
        end

        for gene in contributing_genes
            push!(summary_links, Link(
                kind=:produces, from=gene, to=s.name,
                properties=Dict{Symbol, Any}(), scope=:gene,
            ))
        end
    end

    (genes, get(nodes_by_parent, nothing, Entity[]), aux_links, summary_links)
end

"""
    _resolve_reg_endpoint(name, gene_names, suffix) -> Symbol

Resolve a regulatory link endpoint to species level.
If `name` is a gene, append `.suffix` (e.g. `:A` -> `Symbol("A.proteins")`).
Otherwise keep as-is (e.g. `:AA` stays `:AA`).
"""
function _resolve_reg_endpoint(name::Symbol, gene_names::Set{Symbol}, suffix::String)::Symbol
    name in gene_names ? Symbol("$(name).$(suffix)") : name
end

"""
    _regulatory_link_parameters(l) -> Vector{Parameter}

Build the parameter list for a regulatory link from `Models.describe`. The
property keys (`:at`, `:k`) are exactly the V1 parameter fields exposed by the
link kind; the canonical symbol is `V1.parameter_name(to, kind, from, field)`.
"""
function _regulatory_link_parameters(l)::Vector{Parameter}
    [
        Parameter(name=string(key),
                  symbol=string(V1.parameter_name(l.to, l.kind, l.from, key)))
        for key in keys(l.properties)
    ]
end

function entity(definition::V1.Definition, f!::Wrapped; include_reactions::Union{Bool, Set{Symbol}}=true)
    gene_names = Set{Symbol}(g.name for g in definition.genes)

    desc = Models.describe(definition)
    components = Dict(typeof(d) => d for d in desc.descriptions)
    raw_links = components[Models.Network].links

    if include_reactions === true
        # Species-level resolution for regulatory links
        reg_links = map(raw_links) do l
            from_resolved = _resolve_reg_endpoint(l.from, gene_names, "proteins")
            to_suffix = l.kind == :proteolysis ? "proteins" : "active"
            to_resolved = _resolve_reg_endpoint(l.to, gene_names, to_suffix)
            Link(; kind=l.kind, from=from_resolved, to=to_resolved,
                  properties=l.properties,
                  parameters=_regulatory_link_parameters(l),
                  scope=:all)
        end

        filter_ids = _regulatory_reaction_ids(definition, raw_links)
        rs = f!.model.definition
        rs_network = entity(rs, filter_ids)
        _attach_v1_transition_rates!(rs_network, definition)
        gene_nodes, aux_nodes, aux_links, summary_links = _genes_from_reaction_network(rs_network)
        nodes = vcat(gene_nodes, aux_nodes)
        links = vcat(reg_links, aux_links, summary_links)
    elseif include_reactions === false
        # Kronecker/random-diff: no species, keep gene-level regulatory links
        reg_links = map(raw_links) do l
            Link(; kind=l.kind, from=l.from, to=l.to,
                  properties=l.properties,
                  parameters=_regulatory_link_parameters(l),
                  scope=:all)
        end
        nodes = [Entity(kind=:gene, name=g.name) for g in definition.genes]
        links = reg_links
    else
        # Partial: species detail only for genes in include_reactions::Set{Symbol}
        species_gene_set = include_reactions::Set{Symbol}
        nodes, links = _entity_partial_species(definition, f!, gene_names, raw_links, species_gene_set)
    end

    Entity(
        kind=:v1_model,
        name=:v1_model,
        properties=Dict(:polymerases => definition.polymerases, :ribosomes => definition.ribosomes, :proteasomes => definition.proteasomes),
        nodes=nodes,
        links=links
    )
end

"""
    _entity_partial_species(definition, f!, gene_names, raw_links, species_gene_set)

Build V1 entity nodes/links with species detail only for genes in `species_gene_set`.
Genes outside the set get flat gene nodes; regulatory links between two included
genes are resolved to species level, others stay at gene level.
"""
function _entity_partial_species(
    definition::V1.Definition, f!::Wrapped,
    gene_names::Set{Symbol}, raw_links, species_gene_set::Set{Symbol},
)
    # Regulatory links: resolve endpoints to species only when both genes are included
    reg_links = map(raw_links) do l
        params = _regulatory_link_parameters(l)
        if l.from ∈ species_gene_set && l.to ∈ species_gene_set
            from_resolved = _resolve_reg_endpoint(l.from, gene_names, "proteins")
            to_suffix = l.kind == :proteolysis ? "proteins" : "active"
            to_resolved = _resolve_reg_endpoint(l.to, gene_names, to_suffix)
            Link(; kind=l.kind, from=from_resolved, to=to_resolved,
                  properties=l.properties, parameters=params, scope=:all)
        else
            Link(; kind=l.kind, from=l.from, to=l.to,
                  properties=l.properties, parameters=params, scope=:all)
        end
    end

    # Build filtered RS entity for included genes only
    filter_ids = _regulatory_reaction_ids(definition, raw_links)
    rs = f!.model.definition
    rs_network = entity(rs, filter_ids; species_genes=species_gene_set)
    species_gene_nodes, aux_nodes, aux_links, summary_links = _genes_from_reaction_network(rs_network)

    # Flat nodes for excluded genes
    flat_gene_nodes = [
        Entity(kind=:gene, name=g.name)
        for g in definition.genes if g.name ∉ species_gene_set
    ]

    nodes = vcat(species_gene_nodes, flat_gene_nodes, aux_nodes)
    links = vcat(reg_links, aux_links, summary_links)
    (nodes, links)
end

function _collect_core_symbols(t::Differentiation.Transient, symbols::Set{Symbol})
    # Timer genes are created anonymous (name = Symbol()) in RandomDifferentiation
    # and renamed to "$(differentiator)_timer" by Differentiation.build.
    # Derive the timer name from the differentiator to match what ends up in the V1 model.
    diff_name = _diff_node_name(t.differentiator)
    push!(symbols, diff_name)
    push!(symbols, Symbol("$(diff_name)_timer"))
    _collect_core_symbols(t.next, symbols)
    _collect_core_symbols(t.alternative, symbols)
end

function _collect_core_symbols(s::Symbol, symbols::Set{Symbol})
    push!(symbols, s)
end

function _collect_core_symbols(g::V1.Gene, symbols::Set{Symbol})
    push!(symbols, g.name)
end

# Collect timer gene names by deriving from differentiator names (same convention as make_timer!).
function _collect_timer_symbols!(t::Differentiation.Transient, symbols::Set{Symbol})
    diff_name = _diff_node_name(t.differentiator)
    push!(symbols, Symbol("$(diff_name)_timer"))
    _collect_timer_child!(t.next, symbols)
    _collect_timer_child!(t.alternative, symbols)
end
_collect_timer_child!(t::Differentiation.Transient, symbols) = _collect_timer_symbols!(t, symbols)
_collect_timer_child!(::Any, ::Any) = nothing

# Helpers to extract a gene name from a differentiator/leaf, which may be a V1.Gene or plain Symbol.
_diff_node_name(g::V1.Gene)::Symbol = g.name
_diff_node_name(s::Symbol)::Symbol = s

# Traverse the differentiation tree and emit invisible spring edges (scope=:gene, weight=0.5).
function _collect_tree_links!(t::Differentiation.Transient, links::Vector{Link})
    parent_name = _diff_node_name(t.differentiator)
    _collect_tree_child_link!(parent_name, t.next, links)
    _collect_tree_child_link!(parent_name, t.alternative, links)
end

function _collect_tree_child_link!(parent::Symbol, child::Differentiation.Transient, links::Vector{Link})
    child_name = _diff_node_name(child.differentiator)
    push!(links, Link(kind=:differentiation_tree, from=parent, to=child_name,
                      scope=:gene, properties=Dict{Symbol,Any}(:weight => 0.5)))
    _collect_tree_links!(child, links)
end

function _collect_tree_child_link!(parent::Symbol, child::Union{V1.Gene, Symbol}, links::Vector{Link})
    push!(links, Link(kind=:differentiation_tree, from=parent, to=_diff_node_name(child),
                      scope=:gene, properties=Dict{Symbol,Any}(:weight => 0.5)))
end

function entity(definition::Differentiation.Definition, f!::Wrapped; kw...)
    v1_entity = entity(f!.model; kw...)

    core_symbols = Set{Symbol}()
    _collect_core_symbols(definition.differentiation, core_symbols)

    core_nodes = [n for n in v1_entity.nodes if n.name in core_symbols]
    core_links = [l for l in v1_entity.links
                  if _belongs_to_gene_set(l.from, core_symbols) && _belongs_to_gene_set(l.to, core_symbols)]

    diff_core = Entity(
        kind=:differentiation_core,
        name=:differentiation_core,
        nodes=core_nodes,
        links=core_links
    )

    peripheral_nodes = [n for n in v1_entity.nodes if n.name ∉ core_symbols]
    peripheral_links = [l for l in v1_entity.links
                        if !(_belongs_to_gene_set(l.from, core_symbols) && _belongs_to_gene_set(l.to, core_symbols))]

    tree_links = Link[]
    _collect_tree_links!(definition.differentiation, tree_links)

    Entity(
        kind=:differentiation_model,
        name=:differentiation_model,
        properties=v1_entity.properties,
        nodes=vcat([diff_core], peripheral_nodes),
        links=vcat(peripheral_links, tree_links)
    )
end

entity(f!::Primitive; kw...) = entity(f!.f!; kw...)

entity(f!::Wrapped; kw...) = entity(f!.definition, f!; kw...)

# TODO include more info here?
entity(f!::Instant; kw...) = Entity(kind=:instant, name=:instant)

# Kronecker networks: always skip species/reaction detail (too large)
function entity(definition::KroneckerNetworks.Definition, f!::Wrapped; include_reactions=true, kw...)
    v1_entity = entity(f!.model; include_reactions=false, kw...)
    tagged_nodes = [
        Entity(kind=n.kind, name=n.name,
               properties=merge(n.properties, Dict(:model_kind => "kronecker")),
               nodes=n.nodes, links=n.links)
        for n in v1_entity.nodes
    ]
    Entity(
        kind=:kronecker_network,
        name=:kronecker_network,
        properties=v1_entity.properties,
        nodes=tagged_nodes,
        links=v1_entity.links
    )
end

# Random differentiation: species detail for core genes only (peripheral skipped).
# Tags timer and peripheral (Kronecker) nodes within the differentiation_model entity.
function entity(definition::RandomDifferentiation.Definition, f!::Wrapped; include_reactions=true, kw...)
    diff_def = f!.model.definition  # Differentiation.Definition (already instantiated)

    core_symbols = Set{Symbol}()
    _collect_core_symbols(diff_def.differentiation, core_symbols)
    timer_symbols = Set{Symbol}()
    _collect_timer_symbols!(diff_def.differentiation, timer_symbols)

    # Build entity with species detail for core genes, flat nodes for peripheral
    base_entity = entity(f!.model; include_reactions=core_symbols, kw...)

    function _tag(n::Entity)
        n.kind != :gene && return n
        if n.name ∉ core_symbols
            return Entity(kind=n.kind, name=n.name,
                properties=merge(n.properties, Dict(:model_kind => "kronecker")),
                nodes=n.nodes, links=n.links)
        elseif n.name ∈ timer_symbols
            return Entity(kind=n.kind, name=n.name,
                properties=merge(n.properties, Dict(:model_kind => "timer")),
                nodes=n.nodes, links=n.links)
        end
        return n
    end

    # base_entity.nodes = [diff_core_entity, peripheral_gene1, ...]
    # diff_core_entity.nodes = [core_gene1, ...]
    tagged_nodes = map(base_entity.nodes) do child
        if child.kind == :differentiation_core
            Entity(kind=child.kind, name=child.name, properties=child.properties,
                   nodes=map(_tag, child.nodes), links=child.links)
        else
            _tag(child)
        end
    end

    # Tag regulatory links that involve at least one peripheral (Kronecker) node.
    tagged_links = map(base_entity.links) do l
        if !_belongs_to_gene_set(l.from, core_symbols) || !_belongs_to_gene_set(l.to, core_symbols)
            Link(kind=l.kind, from=l.from, to=l.to, scope=l.scope,
                 properties=merge(l.properties, Dict{Symbol,Any}(:peripheral => true)))
        else
            l
        end
    end

    tree_links = Link[]
    _collect_tree_links!(diff_def.differentiation, tree_links)

    Entity(
        kind=:random_differentiation,
        name=:random_differentiation,
        properties=base_entity.properties,
        nodes=tagged_nodes,
        links=vcat(tagged_links, tree_links)
    )
end

# simply descend if custom entity not implemented for the definition
# ? maybe we should create nested entities here to tag with information from higher level models?
entity(definition, f!::Wrapped; kw...) = entity(f!.model; kw...)

# flattened hierarchy for downstream use
@kwdef struct Node
    kind::Symbol
    name::Symbol
    parent::Union{Symbol, Nothing} = nothing
    properties::Dict{Symbol, Any} = Dict{Symbol, Any}()
    parameters::Vector{Parameter} = Parameter[]
end

Node(entity::Entity, parent::Union{Symbol, Nothing}=nothing) =
    Node(kind=entity.kind, name=entity.name, parent=parent,
         properties=entity.properties, parameters=entity.parameters)

function flatten(entity::Entity, parent::Union{Symbol, Nothing}=nothing)::Tuple{Vector{Node}, Vector{Link}}
    nodes = Node[Node(entity, parent)]
    links = copy(entity.links)

    for child in entity.nodes
        child_nodes, child_links = flatten(child, entity.name)
        append!(nodes, child_nodes)
        append!(links, child_links)
    end

    (nodes, links)
end


end
