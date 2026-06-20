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
:type => :rename_reaction, :reactionName => :old, :newName => :new
:type => :delete_reaction, :reactionName => :rxn-1
:type => :add_reaction, :species => Symbol("A.proteins"), :role => :from
:type => :add_reagent,  :reactionName => :rxn-1, :species => Symbol("B.proteins"), :role => :to
:type => :remove_reagent, :reactionName => :rxn-1, :species => Symbol("B.proteins"), :role => :to
:type => :set_stoichiometry, :reactionName => :rxn-1, :species => Symbol("A.proteins"), :role => :from, :value => 2
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
       add_reaction, rename_reaction, remove_reaction,
       add_reagent, remove_reagent, set_stoichiometry,
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
    validate_gene_name(name)
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
    validate_gene_name(new)
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
    rename_reaction(definition, old, new) -> Definition

Rename the auxiliary reaction named `old` to `new`. Only reactions in
`definition.reactions` carry a user-facing name — cascade and regulatory
transition reactions are generated per-gene and aren't renameable. A no-op
when `old == new`. Errors if `old` doesn't exist or `new` is already taken
by another reaction (names must be unique within a model).
"""
function rename_reaction(definition::Definition, old::Symbol, new::Symbol)
    old == new && return definition
    i = findfirst(r -> r.name == old, definition.reactions)
    i === nothing && error("reaction `$old` does not exist")
    any(r -> r.name == new, definition.reactions) &&
        error("reaction `$new` already exists")
    reactions′ = collect(definition.reactions)
    r = reactions′[i]
    reactions′[i] = Models.Reaction(; name = new, r.from, r.to, r.k₊, r.k₋)
    Definition(;
        definition.polymerases, definition.ribosomes, definition.proteasomes,
        definition.genes, reactions = reactions′,
    )
end

"""
    remove_reaction(definition, name) -> Definition

Drop the auxiliary reaction named `name`. Errors if it doesn't exist — only
reactions in `definition.reactions` can be removed here; cascade and
regulatory transition reactions are gene-generated and have no such entry.
"""
function remove_reaction(definition::Definition, name::Symbol)
    any(r -> r.name == name, definition.reactions) ||
        error("reaction `$name` does not exist")
    Definition(;
        definition.polymerases, definition.ribosomes, definition.proteasomes,
        definition.genes,
        reactions = filter(r -> r.name != name, definition.reactions),
    )
end

"""
Smallest `rxn-<i>` name not already taken by an existing reaction.
"""
function next_reaction_name(reactions)::Symbol
    existing = Set(r.name for r in reactions)
    i = 1
    while Symbol("rxn-$i") in existing
        i += 1
    end
    Symbol("rxn-$i")
end

"""
    add_reaction(definition, species, role; k₊=1e-5, k₋=0.0) -> Definition

Append a new auto-named auxiliary reaction seeded with `species` as its sole
reagent — a substrate when `role === :from` (a `species → ∅` style reaction)
or a product when `role === :to`. Seeding with one reagent keeps the reaction
non-empty so it renders immediately; the user grows it from there. `species`
is stored verbatim as the (explicit) reagent key. `k₊` must be `> 0` for the
reaction to appear in the built model.
"""
function add_reaction(definition::Definition, species::Symbol, role::Symbol;
                      k₊::Float64 = 1e-5, k₋::Float64 = 0.0)
    role in (:from, :to) ||
        error("reaction role must be `:from` or `:to`, got `$role`")
    name = next_reaction_name(definition.reactions)
    reagents = Models.Reagents(Dict{Symbol, Int}(species => 1))
    from = role === :from ? reagents : Models.Reagents()
    to   = role === :to   ? reagents : Models.Reagents()
    new_rxn = Models.Reaction(; name, from, to, k₊, k₋)
    Definition(;
        definition.polymerases, definition.ribosomes, definition.proteasomes,
        definition.genes,
        reactions = [definition.reactions..., new_rxn],
    )
end

"""
    add_reagent(definition, name, species, role; stoich=1) -> Definition

Connect `species` to reaction `name` as a substrate (`role === :from`) or
product (`role === :to`). `species` is stored verbatim as an explicit reagent
key. Errors if the reaction doesn't exist or `species` is already connected on
that side.
"""
function add_reagent(definition::Definition, name::Symbol, species::Symbol, role::Symbol; stoich::Int = 1)
    role in (:from, :to) || error("reagent role must be `:from` or `:to`, got `$role`")
    stoich >= 1 || error("stoichiometry must be ≥ 1")
    update_reaction(definition, name) do rxn
        reagents = role === :from ? rxn.from : rxn.to
        find_reagent_key(definition, reagents, species) === nothing ||
            error("`$species` is already a $(role === :from ? "substrate" : "product") of `$name`")
        counts′ = copy(reagents.counts)
        counts′[species] = stoich
        with_reagents(rxn, role, counts′)
    end
end

"""
    remove_reagent(definition, name, species, role) -> Definition

Disconnect `species` from reaction `name` on side `role`. Enforces the ≥1
reagent invariant: removing the reaction's last reagent is refused (delete the
reaction instead). Resolves bare-gene reagent keys so `A.proteins` matches a
stored `A`.
"""
function remove_reagent(definition::Definition, name::Symbol, species::Symbol, role::Symbol)
    role in (:from, :to) || error("reagent role must be `:from` or `:to`, got `$role`")
    update_reaction(definition, name) do rxn
        reagents = role === :from ? rxn.from : rxn.to
        key = find_reagent_key(definition, reagents, species)
        key === nothing &&
            error("`$species` is not a $(role === :from ? "substrate" : "product") of `$name`")
        length(rxn.from.counts) + length(rxn.to.counts) <= 1 &&
            error("cannot remove the last reagent of `$name`; delete the reaction instead")
        counts′ = copy(reagents.counts)
        delete!(counts′, key)
        with_reagents(rxn, role, counts′)
    end
end

"""
    set_stoichiometry(definition, name, species, role, value) -> Definition

Set the stoichiometry of `species` on side `role` of reaction `name`. A
`value <= 0` removes the reagent (subject to the ≥1 invariant). Otherwise the
key is *canonicalised* to the explicit species id passed in (so a previously
bare `A` is rewritten to `A.proteins`), eliminating the bare-vs-explicit
ambiguity for future edits.
"""
function set_stoichiometry(definition::Definition, name::Symbol, species::Symbol, role::Symbol, value::Int)
    role in (:from, :to) || error("reagent role must be `:from` or `:to`, got `$role`")
    value <= 0 && return remove_reagent(definition, name, species, role)
    update_reaction(definition, name) do rxn
        reagents = role === :from ? rxn.from : rxn.to
        key = find_reagent_key(definition, reagents, species)
        key === nothing &&
            error("`$species` is not a $(role === :from ? "substrate" : "product") of `$name`")
        counts′ = copy(reagents.counts)
        delete!(counts′, key)        # canonicalise bare-gene keys to explicit ids
        counts′[species] = value
        with_reagents(rxn, role, counts′)
    end
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
    elseif t === :rename_reaction
        rename_reaction(definition,
            Symbol(action[:reactionName]), Symbol(action[:newName]))
    elseif t === :delete_reaction
        remove_reaction(definition, Symbol(action[:reactionName]))
    elseif t === :add_reaction
        add_reaction(definition, Symbol(action[:species]), Symbol(action[:role]))
    elseif t === :add_reagent
        add_reagent(definition,
            Symbol(action[:reactionName]), Symbol(action[:species]), Symbol(action[:role]))
    elseif t === :remove_reagent
        remove_reagent(definition,
            Symbol(action[:reactionName]), Symbol(action[:species]), Symbol(action[:role]))
    elseif t === :set_stoichiometry
        set_stoichiometry(definition,
            Symbol(action[:reactionName]), Symbol(action[:species]), Symbol(action[:role]),
            round(Int, action[:value]))
    elseif t === :create_link
        add_slot(definition,
            gene_of(action[:target]), Symbol(action[:kind]), gene_of(action[:source]);
            at = Float64(get(action, :at, 1.0)),
            k  = Float64(get(action, :k, -1.0)))
    elseif t === :delete_link
        remove_slot(definition,
            gene_of(action[:target]), Symbol(action[:kind]), gene_of(action[:source]))
    elseif t === :change_link_kind
        change_slot_kind(definition,
            gene_of(action[:target]),
            Symbol(action[:oldKind]), Symbol(action[:newKind]),
            gene_of(action[:source]))
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
Apply `f(reaction)` to the reaction named `name`, returning a fresh Definition.
Reaction order is preserved so layouts stay stable.
"""
function update_reaction(f, definition::Definition, name::Symbol)
    i = findfirst(r -> r.name == name, definition.reactions)
    i === nothing && error("reaction `$name` does not exist")
    reactions′ = collect(definition.reactions)
    reactions′[i] = f(definition.reactions[i])
    Definition(;
        definition.polymerases, definition.ribosomes, definition.proteasomes,
        definition.genes, reactions = reactions′,
    )
end

"""
Rebuild `rxn` with the `role` side (`:from`/`:to`) replaced by `counts`, leaving
the other side and the rate constants untouched.
"""
function with_reagents(rxn, role::Symbol, counts::AbstractDict{Symbol, Int})
    reagents = Models.Reagents(counts)
    role === :from ?
        Models.Reaction(; rxn.name, from = reagents, rxn.to, rxn.k₊, rxn.k₋) :
        Models.Reaction(; rxn.name, rxn.from, to = reagents, rxn.k₊, rxn.k₋)
end

"""
Find the reagent key in `reagents` that denotes `species`, resolving bare gene
names to their protein species (`A` matches a queried `A.proteins`). Returns the
stored key, or `nothing` if absent.
"""
function find_reagent_key(definition::Definition, reagents, species::Symbol)
    gene_names = Set(g.name for g in definition.genes)
    resolve(k) = k in gene_names ? Symbol("$(k).proteins") : k
    for k in keys(reagents.counts)
        (k == species || resolve(k) == species) && return k
    end
    nothing
end

"""
Normalise a link endpoint id to its owning gene. Endpoints arrive either
as gene ids (`skn-1`, from a freshly drawn link) or species ids
(`skn-1.proteins`, from an existing link). v1 slots key `from`/`target`
by gene name, so we take everything before the first `.`. Splitting on
`.` (not `-`) is safe because gene names may contain `-` but never `.`
(enforced by [`validate_gene_name`](@ref)).
"""
gene_of(endpoint)::Symbol = Symbol(first(split(string(endpoint), '.')))

"""
Reject gene names containing `.`. The core library tolerates dotted gene
names (it parses only the *last* `.` as the species separator), but the
app's id scheme splits on the *first* `.` to strip species suffixes
(`gene_of`, `species_components`, the frontend `geneOf`), so a dot would be
mis-parsed as a gene/species boundary. Identifiers can use `-`/`_` instead.
"""
function validate_gene_name(name::Symbol)
    occursin('.', string(name)) &&
        error("gene name `$name` cannot contain `.`")
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
