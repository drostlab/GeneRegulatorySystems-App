/**
 * Converts a UnionNetwork into Cytoscape element definitions.
 *
 * Two view levels:
 * - Gene view (zoomed out): gene nodes, orphan species, and edges with
 *   scope 'all' (endpoints resolved to gene parents) or scope 'gene'.
 * - Species view (zoomed in): child species/reactions, orphan reactions,
 *   and edges with scope 'all' (actual endpoints) or scope 'species'.
 *
 * Filters out model-level container nodes and machinery species.
 */
import type { UnionNetwork, Node, Link } from '@/types/network'
import { MODEL_NODE_KINDS, MACHINERY_SPECIES, linkId } from '@/types/network'
import { getEdgeColour, shouldShowEdgeLabel } from './networkStyles'
import { getTheme } from '@/config/theme'
import { lighten, darken, contrastTextColour } from '@/utils/colorUtils'
import logging from '@/utils/logging'

const log = logging.getLogger('networkElements')

/** Kinds that only appear in the species (zoomed-in) view. */
const DETAIL_KINDS = new Set(['species', 'reaction'])

// ============================================================================
// Public API
// ============================================================================

/**
 * Gene-level elements for the zoomed-out view.
 *
 * Includes gene nodes, orphan species, and edges scoped 'all' or 'gene'.
 * For 'all'-scoped edges, endpoints are resolved to their gene parent.
 *
 * @param network - the union network from the backend
 * @param geneColours - mapping of gene name to hex colour
 * @returns Cytoscape element definitions for the gene view
 */
export function getGeneViewElements(
    network: UnionNetwork,
    geneColours: Record<string, string>,
    isDark = false,
): cytoscape.ElementDefinition[] {
    const elements: cytoscape.ElementDefinition[] = []
    const geneNames = buildGeneNameSet(network)
    const nodeParentMap = buildNodeParentMap(network, geneNames)

    // Nodes: genes + orphan species (skip all reactions and gene-parented species)
    for (const node of network.nodes) {
        if (MODEL_NODE_KINDS.has(node.kind)) continue
        if (isMachinery(node)) continue
        if (node.kind === 'reaction') continue
        if (node.kind === 'species' && hasGeneParent(node, geneNames)) continue

        const el = buildNodeElement(node, geneColours, geneNames, false, isDark)
        if (el) elements.push(el)
    }

    const geneViewNodeIds = new Set(elements.map(e => e.data.id as string))

    // Edges: scope 'gene' directly, scope 'all' with parent resolution.
    // Keep each union link distinct (no endpoint-based deduplication) so
    // property-variant edges remain separate and can be excluded per model.

    for (const link of network.links) {
        if (link.scope === 'species') continue

        const resolvedFrom = link.scope === 'all'
            ? resolveToGeneParent(link.from, nodeParentMap)
            : link.from
        const resolvedTo = link.scope === 'all'
            ? resolveToGeneParent(link.to, nodeParentMap)
            : link.to

        // Skip edges whose resolved endpoints aren't in this view
        if (!geneViewNodeIds.has(resolvedFrom) || !geneViewNodeIds.has(resolvedTo)) continue

        const id = linkId(link)
        elements.push(buildEdgeElement(link, resolvedFrom, resolvedTo, id, [id]))
    }

    log.debug(`Gene view: ${elements.length} elements`)
    return elements
}

/**
 * Species-level elements for the zoomed-in view.
 *
 * Includes child species (as compound children of genes), child reactions,
 * orphan reactions, and edges scoped 'all' or 'species'.
 *
 * @param network - the union network from the backend
 * @param geneColours - mapping of gene name to hex colour
 * @returns Cytoscape element definitions for the species view
 */
export function getSpeciesViewElements(
    network: UnionNetwork,
    geneColours: Record<string, string>,
    isDark = false,
): cytoscape.ElementDefinition[] {
    const elements: cytoscape.ElementDefinition[] = []
    const geneNames = buildGeneNameSet(network)

    // Nodes: all species and reactions (parented or orphan)
    for (const node of network.nodes) {
        if (MODEL_NODE_KINDS.has(node.kind)) continue
        if (!DETAIL_KINDS.has(node.kind)) continue
        if (isMachinery(node)) continue

        const el = buildNodeElement(node, geneColours, geneNames, true, isDark)
        if (el) elements.push(el)
    }

    // All non-excluded node IDs (for edge connectivity across both views)
    const allNodeIds = new Set(
        network.nodes
            .filter(n => !MODEL_NODE_KINDS.has(n.kind) && !isMachinery(n))
            .map(n => n.name),
    )
    const speciesNodeIds = new Set(elements.map(e => e.data.id as string))

    // Genes that have species/reaction children (will become compound parents)
    const genesWithSpecies = new Set<string>()
    for (const node of network.nodes) {
        if (DETAIL_KINDS.has(node.kind) && node.parent && geneNames.has(node.parent)) {
            genesWithSpecies.add(node.parent)
        }
    }

    // Edges: scope 'species' + scope 'all' (at actual endpoints)
    for (const link of network.links) {
        if (link.scope === 'gene') continue
        if (!allNodeIds.has(link.from) || !allNodeIds.has(link.to)) continue

        // Include if at least one endpoint is a species/reaction node
        if (speciesNodeIds.has(link.from) || speciesNodeIds.has(link.to)) {
            elements.push(buildEdgeElement(link, link.from, link.to, linkId(link)))
            continue
        }

        // Also include gene-level edges where at least one gene lacks species children.
        // These stay visible at gene level even in the species view.
        const fromIsFlat = geneNames.has(link.from) && !genesWithSpecies.has(link.from)
        const toIsFlat = geneNames.has(link.to) && !genesWithSpecies.has(link.to)
        if (fromIsFlat || toIsFlat) {
            elements.push(buildEdgeElement(link, link.from, link.to, linkId(link)))
        }
    }

    log.debug(`Species view: ${elements.length} elements`)
    return elements
}

/**
 * Build a map from node name to its gene parent (if any).
 *
 * Used by the gene view to resolve species-level edge endpoints
 * up to their parent gene.
 *
 * @param network - the union network
 * @param geneNames - set of gene node names
 * @returns map from node name to gene parent name (or the node itself if it's a gene/orphan)
 */
export function buildNodeParentMap(
    network: UnionNetwork,
    geneNames: Set<string>,
): Map<string, string> {
    const parentMap = new Map<string, string>()
    for (const node of network.nodes) {
        if (MODEL_NODE_KINDS.has(node.kind)) continue
        if (geneNames.has(node.name)) {
            parentMap.set(node.name, node.name)
        } else if (node.parent && geneNames.has(node.parent)) {
            parentMap.set(node.name, node.parent)
        } else {
            // Orphan: resolves to itself
            parentMap.set(node.name, node.name)
        }
    }
    return parentMap
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Build the set of gene node names from the network.
 * @param network - the union network
 */
function buildGeneNameSet(network: UnionNetwork): Set<string> {
    return new Set(
        network.nodes.filter(n => n.kind === 'gene').map(n => n.name),
    )
}

/**
 * Check whether a node has a gene as its parent.
 * @param node - the node to check
 * @param geneNames - set of gene node names
 */
function hasGeneParent(node: Node, geneNames: Set<string>): boolean {
    return node.parent !== null && geneNames.has(node.parent)
}

/**
 * Check whether a node represents cellular machinery (filtered out).
 * @param node - the node to check
 */
function isMachinery(node: Node): boolean {
    return MACHINERY_SPECIES.has(node.name)
}

/**
 * Resolve a node ID to its gene parent via the parent map.
 * Falls back to the node itself if no gene parent exists.
 *
 * @param nodeId - the node name to resolve
 * @param parentMap - map from node name to gene parent
 */
function resolveToGeneParent(nodeId: string, parentMap: Map<string, string>): string {
    return parentMap.get(nodeId) ?? nodeId
}

/**
 * Build a Cytoscape node element from a backend Node.
 *
 * @param node - the backend node
 * @param geneColours - gene colour mapping
 * @param geneNames - set of gene names
 * @param asCompoundChild - whether to set cytoscape parent for compound layout
 */
function buildNodeElement(
    node: Node,
    geneColours: Record<string, string>,
    geneNames: Set<string>,
    asCompoundChild: boolean,
    isDark = false,
): cytoscape.ElementDefinition | null {
    const colour = getNodeColour(node, geneColours)
    const isOrphanSpecies = node.kind === 'species' && !hasGeneParent(node, geneNames)
    const cssClass = isOrphanSpecies ? 'orphan-species' : node.kind

    // Compound parent for species/reactions inside a gene
    const isCompoundChild = asCompoundChild
        && (node.kind === 'species' || node.kind === 'reaction')
        && hasGeneParent(node, geneNames)
    const cytoscapeParent = isCompoundChild ? node.parent! : undefined

    // Label: species_type for species, name otherwise
    const label = node.kind === 'species' && node.properties?.species_type
        ? String(node.properties.species_type)
        : node.name

    // Parent colour for reaction label backgrounds (lightened/darkened per theme)
    const parentColour = node.parent && node.parent in geneColours
        ? (isDark ? darken(geneColours[node.parent]!, 0.3) : lighten(geneColours[node.parent]!, 0.7))
        : colour

    const textColour = node.kind === 'gene' ? contrastTextColour(colour) : undefined

    return {
        data: {
            id: node.name,
            label,
            kind: node.kind,
            parent: cytoscapeParent,
            geneParent: node.parent,
            colour,
            textColour,
            parentColour,
            ...node.properties,
        },
        classes: cssClass,
    }
}

/**
 * Build a Cytoscape edge element from a backend Link.
 *
 * @param link - the backend link
 * @param source - resolved source node ID
 * @param target - resolved target node ID
 * @param edgeId - unique edge identifier
 */
function buildEdgeElement(
    link: Link,
    source: string,
    target: string,
    edgeId: string,
    originalLinkIds?: string[],
): cytoscape.ElementDefinition {
    const edgeColour = getEdgeColour(link.kind)
    const label = shouldShowEdgeLabel(link.kind) ? formatLinkLabel(link) : ''
    const isSelfLoop = source === target

    const at = (link.properties.at as number) ?? 1
    const isPeripheral = link.properties.peripheral === true
    const weight = 1 / Math.max(at, 0.1)

    return {
        data: {
            id: edgeId,
            source,
            target,
            kind: link.kind,
            scope: link.scope,
            edgeColour,
            label,
            at,
            weight,
            originalLinkIds: originalLinkIds ?? [linkId(link)],
            ...link.properties,
        },
        classes: `${link.kind}${isSelfLoop ? ' loop' : ''}${isPeripheral ? ' peripheral' : ''}`,
    }
}

/**
 * Determine the display colour for a node.
 *
 * @param node - the backend node
 * @param geneColours - gene colour mapping
 */
function getNodeColour(node: Node, geneColours: Record<string, string>): string {
    const fallback = getTheme(false).network.nodeFallback
    if (node.kind === 'gene') {
        return geneColours[node.name] ?? fallback
    }
    if (node.parent && geneColours[node.parent]) {
        return geneColours[node.parent]!
    }
    return fallback
}

/**
 * Format link properties as a label string.
 * @param link - the backend link
 */
function formatLinkLabel(link: Link): string {
    const entries = Object.entries(link.properties ?? {})
    if (entries.length === 0) return ''

    if (entries.length === 1) {
        const [key, value] = entries[0]!
        return formatPropertyValue(value, key)
    }

    const parts: string[] = []
    for (const [key, value] of entries) {
        const formatted = formatPropertyValue(value, key)
        parts.push(`${key}=${formatted}`)
    }
    return parts.join(' ')
}

/**
 * Format a numeric or string property value for display.
 *
 * @param value - the property value
 * @param key - the property key (affects formatting)
 */
function formatPropertyValue(value: any, key: string = ''): string {
    if (typeof value === 'number') {
        if (key === 'stoichiometry' && Number.isInteger(value)) {
            return String(value)
        }
        return value.toFixed(2)
    }
    return value !== null && value !== undefined ? String(value) : ''
}
