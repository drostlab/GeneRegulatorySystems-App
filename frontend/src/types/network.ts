/**
 * Network types matching Julia backend NetworkRepresentation module
 */

export interface Node {
    kind: string
    name: string
    parent: string | null
    properties: Record<string, any>
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
    scope: LinkScope
}

export interface Network {
    nodes: Node[]
    links: Link[]
}

/** Nodes and links absent from a specific model (relative to the union). */
export interface ModelExclusions {
    nodes: string[]
    links: string[]
}

/** Union of all model networks with per-model exclusion lists. */
export interface UnionNetwork {
    nodes: Node[]
    links: Link[]
    model_exclusions: Record<string, ModelExclusions>
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

