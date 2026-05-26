"""
Pure structural edits on a v1 [`V1.Definition`](@ref).

Each helper returns a fresh `Definition`; the input is never mutated. The
caller is responsible for any rebuild step (`V1.build`) or schedule
re-binding that follows — these functions stay deliberately ignorant of
the model and schedule layers above so they can be unit-tested in
isolation.

The action dispatcher [`apply_edit`](@ref) accepts a `Symbol`-keyed dict
shaped like the frontend's `RawEditAction` (sans `model_path`, which the
caller has already used to resolve the target Definition):

```
:type => :create_gene,  :name    => :gene_3
:type => :delete_gene,  :geneId  => :gene_3
:type => :rename_gene,  :geneId  => :old, :newName => :new
:type => :create_link,  :source  => :gene_2, :target => :gene_1, :kind => :activation
:type => :delete_link,  :source  => :gene_2, :target => :gene_1, :kind => :activation
:type => :change_link_kind, :source => :gene_2, :target => :gene_1,
                            :oldKind => :activation, :newKind => :repression
:type => :set_parameter, :symbol => :gene_1_activation_gene_2_at, :value => 5.0
```

This module lives in the App backend rather than the GeneRegulatorySystems
library because the library treats `Definition` as immutable spec — these
edits are an app-level concern (user-driven mutation of a reified model).
"""
module V1Editing

using GeneRegulatorySystems.Models
using GeneRegulatorySystems.Models: V1
using GeneRegulatorySystems.Models.V1:
    Definition, Gene, EukaryoteBaseRates,
    HillRegulator, DirectRegulator,
    Activation, Repression, Proteolysis, knockout

export apply_edit,
       add_gene, remove_gene, rename_gene,
       add_slot, remove_slot, change_slot_kind

# ============================================================================
# Defaults for newly-created genes
# ============================================================================

"""
Match the eukaryote `base_rates` defaults under `gene` in the
GeneRegulatorySystems library's `src/models/defaults.specification.json`.
Duplicated here (rather than read at runtime) so the editing API works
without a schedule context; treat the JSON as the source of truth.
"""
const DEFAULT_BASE_RATES = EukaryoteBaseRates(;
    activation    = 2.5,
    deactivation  = 10.0,
    trigger       = 6.6e-7,
    transcription = 0.001,
    processing    = 0.02,
    translation   = 2.5e-9,
    abortion      = 0.01,
    premrna_decay = 0.001,
    mrna_decay    = 0.001,
    protein_decay = 3e-10,
)

# ============================================================================
# Structural edits — each returns a fresh Definition
# ============================================================================

"""
    add_gene(definition, name; base_rates=DEFAULT_BASE_RATES) -> Definition

Append a new gene with no inbound regulation. Errors if `name` already
exists.
"""
function add_gene(definition::Definition, name::Symbol; base_rates = DEFAULT_BASE_RATES)
    any(g -> g.name == name, definition.genes) &&
        error("gene `$name` already exists")
    new_gene = Gene(; name, base_rates)
    Definition(;
        definition.polymerases, definition.ribosomes, definition.proteasomes,
        genes     = [definition.genes..., new_gene],
        definition.reactions,
    )
end

"""
    remove_gene(definition, name) -> Definition

Drop a gene and every inbound slot in other genes that references it as a
transcription factor or protease. Delegates to [`V1.knockout`](@ref).
"""
remove_gene(definition::Definition, name::Symbol) =
    knockout(definition; genes = [name])

"""
    rename_gene(definition, old, new) -> Definition

Rename `old` to `new` everywhere it occurs — the gene itself plus every
slot referencing it as a transcription factor / protease. Errors if `new`
is already taken (`old` excepted, where rename is a no-op).
"""
function rename_gene(definition::Definition, old::Symbol, new::Symbol)
    old == new && return definition
    any(g -> g.name == old, definition.genes) ||
        error("gene `$old` does not exist")
    any(g -> g.name == new, definition.genes) &&
        error("gene `$new` already exists")

    rename_slot(s::HillRegulator) =
        s.from == old ? HillRegulator(; from = new, s.at, s.k) : s
    rename_slot(s::DirectRegulator) =
        s.from == old ? DirectRegulator(; from = new, s.k) : s

    genes′ = map(definition.genes) do g
        Gene(;
            name = g.name == old ? new : g.name,
            g.base_rates, g.unique,
            activation  = Activation(;  g.activation.aggregate,
                                        slots = map(rename_slot, g.activation.slots)),
            repression  = Repression(;  g.repression.aggregate,
                                        slots = map(rename_slot, g.repression.slots)),
            proteolysis = Proteolysis(; slots = map(rename_slot, g.proteolysis.slots)),
        )
    end
    Definition(;
        definition.polymerases, definition.ribosomes, definition.proteasomes,
        genes = genes′, definition.reactions,
    )
end

"""
    add_slot(definition, target, kind, from; at=1.0, k=-1.0) -> Definition

Add a regulatory slot to `target`'s `kind` regulation, with `from` as the
transcription factor / protease source. `kind` ∈ `(:activation, :repression,
:proteolysis)`. Errors on unknown gene, unknown kind, or duplicate slot.
"""
function add_slot(
    definition::Definition,
    target::Symbol, kind::Symbol, from::Symbol;
    at::Float64 = 1.0, k::Float64 = -1.0,
)
    update_gene(definition, target) do g
        find_slot(g, kind, from) === nothing ||
            error("$kind slot from `$from` to `$target` already exists")
        if kind === :activation
            Gene(; g.name, g.base_rates, g.unique, g.repression, g.proteolysis,
                activation = Activation(;
                    g.activation.aggregate,
                    slots = [g.activation.slots..., HillRegulator(; from, at, k)]))
        elseif kind === :repression
            Gene(; g.name, g.base_rates, g.unique, g.activation, g.proteolysis,
                repression = Repression(;
                    g.repression.aggregate,
                    slots = [g.repression.slots..., HillRegulator(; from, at, k)]))
        elseif kind === :proteolysis
            Gene(; g.name, g.base_rates, g.unique, g.activation, g.repression,
                proteolysis = Proteolysis(;
                    slots = [g.proteolysis.slots..., DirectRegulator(; from, k)]))
        else
            error("unknown regulation kind `$kind`")
        end
    end
end

"""
    remove_slot(definition, target, kind, from) -> Definition

Drop the matching slot. Errors if the slot doesn't exist.
"""
function remove_slot(
    definition::Definition,
    target::Symbol, kind::Symbol, from::Symbol,
)
    update_gene(definition, target) do g
        find_slot(g, kind, from) === nothing &&
            error("$kind slot from `$from` to `$target` does not exist")
        drop(slots) = filter(s -> s.from != from, slots)
        if kind === :activation
            Gene(; g.name, g.base_rates, g.unique, g.repression, g.proteolysis,
                activation = Activation(; g.activation.aggregate,
                    slots = drop(g.activation.slots)))
        elseif kind === :repression
            Gene(; g.name, g.base_rates, g.unique, g.activation, g.proteolysis,
                repression = Repression(; g.repression.aggregate,
                    slots = drop(g.repression.slots)))
        elseif kind === :proteolysis
            Gene(; g.name, g.base_rates, g.unique, g.activation, g.repression,
                proteolysis = Proteolysis(; slots = drop(g.proteolysis.slots)))
        else
            error("unknown regulation kind `$kind`")
        end
    end
end

"""
    change_slot_kind(definition, target, old_kind, new_kind, from) -> Definition

Move a slot from one regulation kind to another, preserving `at` (Hill
slots) and `k`. Composes `remove_slot` + `add_slot`, but carries the
existing slot's parameters so a kind flip doesn't reset them.
"""
function change_slot_kind(
    definition::Definition,
    target::Symbol, old_kind::Symbol, new_kind::Symbol, from::Symbol,
)
    old_kind == new_kind && return definition
    target_gene = lookup_gene(definition, target)
    slot = find_slot(target_gene, old_kind, from)
    slot === nothing &&
        error("$old_kind slot from `$from` to `$target` does not exist")
    at = slot isa HillRegulator ? slot.at : 1.0
    k  = slot.k
    add_slot(
        remove_slot(definition, target, old_kind, from),
        target, new_kind, from; at, k,
    )
end

# ============================================================================
# Action dispatcher
# ============================================================================

"""
    apply_edit(definition, action) -> Definition

Dispatch on `action[:type]` and call the matching helper. Action keys
follow the frontend's `RawEditAction` shape (Symbol-keyed).

Parameter edits route through [`Models.remake`](@ref) — they don't change
structure, so the symbolic build can be reused downstream.
"""
function apply_edit(definition::Definition, action::AbstractDict{Symbol})
    t = Symbol(action[:type])
    if t === :create_gene
        add_gene(definition, Symbol(action[:name]))
    elseif t === :delete_gene
        remove_gene(definition, Symbol(action[:geneId]))
    elseif t === :rename_gene
        rename_gene(definition,
            Symbol(action[:geneId]), Symbol(action[:newName]))
    elseif t === :create_link
        add_slot(definition,
            Symbol(action[:target]), Symbol(action[:kind]), Symbol(action[:source]);
            at = Float64(get(action, :at, 1.0)),
            k  = Float64(get(action, :k, -1.0)))
    elseif t === :delete_link
        if haskey(action, :linkId)
            (; from, target, kind) = _parse_link_id(String(action[:linkId]))
            remove_slot(definition, target, kind, from)
        else
            remove_slot(definition,
                Symbol(action[:target]), Symbol(action[:kind]), Symbol(action[:source]))
        end
    elseif t === :change_link_kind
        if haskey(action, :linkId)
            # Frontend sends only `linkId` + new `kind`. Parse the existing
            # link id to recover source/target/old-kind.
            (; from, target, kind) = _parse_link_id(String(action[:linkId]))
            change_slot_kind(definition, target, kind, Symbol(action[:kind]), from)
        else
            change_slot_kind(definition,
                Symbol(action[:target]),
                Symbol(action[:oldKind]), Symbol(action[:newKind]),
                Symbol(action[:source]))
        end
    elseif t === :set_parameter
        Models.remake(definition,
            Dict{Symbol,Float64}(Symbol(action[:symbol]) => Float64(action[:value])))
    else
        error("unknown edit action type: `$t`")
    end
end

# ============================================================================
# Internals
# ============================================================================

function lookup_gene(definition::Definition, name::Symbol)
    i = findfirst(g -> g.name == name, definition.genes)
    i === nothing && error("gene `$name` does not exist")
    definition.genes[i]
end

"""
Apply `f(gene)` to the gene named `name` in-place (functionally — returns a
new Definition). Genes preserve their slot order so layouts stay stable.
"""
function update_gene(f, definition::Definition, name::Symbol)
    i = findfirst(g -> g.name == name, definition.genes)
    i === nothing && error("gene `$name` does not exist")
    genes′ = collect(definition.genes)
    genes′[i] = f(definition.genes[i])
    Definition(;
        definition.polymerases, definition.ribosomes, definition.proteasomes,
        genes = genes′, definition.reactions,
    )
end

"""
Parse a frontend link id of the form `\${from_species}-\${kind}-\${to_species}-\${scope}`
into the v1 slot key `(target_gene, kind, from_gene)`. Species ids carry a
suffix like `.proteins` or `.active`; v1 slots store `from` as the bare gene
name (per the v1 spec convention), so we strip the suffix on both ends.

Assumes none of the components contain literal `-`, which is true for the
canonical gene names and kinds.
"""
function _parse_link_id(link_id::String)
    parts = split(link_id, '-')
    length(parts) == 4 ||
        error("malformed link id (expected `from-kind-to-scope`): $link_id")
    from_species, kind_s, to_species, _ = parts
    from_gene = first(split(from_species, '.'))
    to_gene   = first(split(to_species, '.'))
    return (
        from   = Symbol(from_gene),
        target = Symbol(to_gene),
        kind   = Symbol(kind_s),
    )
end

"""
Look up a slot by `(kind, from)`. Returns the slot or `nothing`.
"""
function find_slot(g::Gene, kind::Symbol, from::Symbol)
    slots = kind === :activation  ? g.activation.slots  :
            kind === :repression  ? g.repression.slots  :
            kind === :proteolysis ? g.proteolysis.slots :
            error("unknown regulation kind `$kind`")
    i = findfirst(s -> s.from == from, slots)
    i === nothing ? nothing : slots[i]
end

end  # module V1Editing
