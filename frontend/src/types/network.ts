/**
 * Network types matching Julia backend NetworkRepresentation module
 */

/**
 * An editable kinetic parameter exposed by a network element.
 *
 * - `name`: human-readable label (e.g. "at", "k", "rate")
 * - `symbol`: canonical backend symbol used by Models.parameters / Models.remake
 *   (e.g. "gene_1.repression.gene_3.at", "gene_1.transcription")
 *
 * Values are NOT carried on the element — they vary per model and live in
 * `UnionNetwork.parameters_by_model_path`, keyed by `symbol`.
 */
export interface Parameter {
    name: string
    symbol: string
}

export interface Node {
    kind: string
    name: string
    parent: string | null
    properties: Record<string, any>
    parameters?: Parameter[]
}

/**
 * Edge scope determines visibility at different zoom levels.
 * - 'all': visible at both zoom levels (endpoints resolved to gene parents when zoomed out)
 * - 'gene': visible only when zoomed out (summary edges like 'produces')
 * - 'species': visible only when zoomed in (substrate/product edges)
 */
export type LinkScope = 'all' | 'gene' | 'species'

export interface Link {
    id?: string
    kind: string
    from: string
    to: string
    properties: Record<string, any>
    parameters?: Parameter[]
    scope: LinkScope
}

export interface Network {
    nodes: Node[]
    links: Link[]
}

/**
 * A reaction participant that has no node drawn in the graph — i.e. a
 * machinery species (polymerase/ribosome/proteasome). Used to fold these
 * back into reaction tooltips, which otherwise only see drawn edges.
 */
export interface HiddenReagent {
    /** Species name, e.g. `polymerases`. */
    species: string
    /** Stoichiometric coefficient. */
    stoichiometry: number
    role: 'substrate' | 'product'
}

/** Nodes and links absent from a specific model (relative to the union). */
export interface ModelExclusions {
    nodes: string[]
    links: string[]
}

/**
 * Union of all model networks with per-model exclusion lists.
 *
 * `parameters_by_model_path` maps `model_path -> (parameter_symbol -> value)`.
 * Resolve a parameter's current value by looking up the active model's map
 * with the parameter's `symbol`.
 */
export interface UnionNetwork {
    nodes: Node[]
    links: Link[]
    model_exclusions: Record<string, ModelExclusions>
    parameters_by_model_path: Record<string, Record<string, number>>
}

/** Generate a stable edge ID matching the backend convention. */
export function linkId(link: Link): string {
    if (link.id && link.id.length > 0) return link.id
    return `${link.from}-${link.kind}-${link.to}`
}

/** Node kinds that represent container/model-level nodes (filtered out of visualisation). */
export const MODEL_NODE_KINDS = new Set([
    'v1_model', 'reaction_system', 'differentiation_model',
    'differentiation_core', 'kronecker_network', 'instant', 'random_differentiation'
])

/** Species names representing cellular machinery (filtered out of visualisation). */
export const MACHINERY_SPECIES = new Set([
    'ribosomes', 'proteasomes', 'polymerases'
])

