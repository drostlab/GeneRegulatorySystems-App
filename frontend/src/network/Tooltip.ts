/**
 * Tooltip on Cytoscape elements, sharing the project-wide GRS tooltip
 * singleton (`v-grs-tooltip` directive's DOM element). This guarantees
 * that hovering a cytoscape edge/node, a chip, or any directive-tagged
 * DOM element uses the exact same tooltip surface.
 *
 * Parameterised by selector (e.g. 'edge', 'node') and a content function
 * that extracts tooltip text from the hovered element.
 */
import type { Core, EventHandler } from 'cytoscape'
import { showGrsTooltip, moveGrsTooltip, hideGrsTooltip } from '@/utils/grsTooltip'

export class Tooltip {
    private cy: Core | null = null
    private onMouseOver: EventHandler | null = null
    private onMouseMove: EventHandler | null = null
    private onMouseOut: EventHandler | null = null

    private readonly selector: string
    private readonly contentFn: (el: any) => string

    /**
     * @param selector - Cytoscape selector (e.g. 'edge', 'node')
     * @param contentFn - returns tooltip text for a given element
     * @param _tooltipId - retained for backward compat; no longer used
     */
    constructor(selector: string, contentFn: (el: any) => string, _tooltipId?: string) {
        this.selector = selector
        this.contentFn = contentFn
    }

    /**
     * Attach hover/move/out listeners to a Cytoscape instance.
     */
    attach(cy: Core): void {
        this.cy = cy

        this.onMouseOver = (evt: any) => {
            const oe = evt.originalEvent as MouseEvent | undefined
            if (!oe) return
            showGrsTooltip(this.contentFn(evt.target), oe.clientX, oe.clientY)
        }
        this.onMouseMove = (evt: any) => {
            const oe = evt.originalEvent as MouseEvent | undefined
            if (!oe) return
            moveGrsTooltip(oe.clientX, oe.clientY)
        }
        this.onMouseOut = () => hideGrsTooltip()

        cy.on('mouseover', this.selector, this.onMouseOver)
        cy.on('mousemove', this.selector, this.onMouseMove)
        cy.on('mouseout', this.selector, this.onMouseOut)
    }

    /**
     * Show the tooltip with the content for `ele` at viewport (client) coords.
     * Used to surface the same tooltip from non-cytoscape triggers (e.g.
     * inline-parameter chip hovers).
     */
    showFor(ele: any, clientX: number, clientY: number): void {
        showGrsTooltip(this.contentFn(ele), clientX, clientY)
    }

    /** Hide the tooltip if visible. */
    hide(): void {
        hideGrsTooltip()
    }

    destroy(): void {
        if (this.cy) {
            if (this.onMouseOver) this.cy.off('mouseover', this.selector, this.onMouseOver)
            if (this.onMouseMove) this.cy.off('mousemove', this.selector, this.onMouseMove)
            if (this.onMouseOut) this.cy.off('mouseout', this.selector, this.onMouseOut)
        }
        this.onMouseOver = null
        this.onMouseMove = null
        this.onMouseOut = null
        this.cy = null
    }
}

import type { Parameter } from '@/types/network'

/**
 * Resolve parameter values for the currently active model.
 * Returns `undefined` if no model is active or the symbol is unknown.
 */
export type ParameterValueLookup = (symbol: string) => number | undefined

/**
 * Format a list of (parameter, value) pairs for tooltip display.
 * Skips parameters whose value is unknown for the active model.
 */
function formatParameterLines(
    parameters: Parameter[] | undefined,
    lookup: ParameterValueLookup,
): string[] {
    if (!parameters || parameters.length === 0) return []
    const lines: string[] = []
    for (const p of parameters) {
        const v = lookup(p.symbol)
        if (v === undefined) continue
        lines.push(`  ${p.name} = ${formatValue(v)}`)
    }
    return lines
}

function formatValue(v: number): string {
    if (!Number.isFinite(v)) return String(v)
    if (v === 0) return '0'
    const abs = Math.abs(v)
    if (abs >= 0.01 && abs < 1000) return v.toFixed(4).replace(/\.?0+$/, '')
    return v.toExponential(2)
}

/** Strip species suffix (`.proteins`, `.active`, …) leaving the gene name. */
function geneOf(nodeId: string): string {
    const i = nodeId.indexOf('.')
    return i === -1 ? nodeId : nodeId.slice(0, i)
}

/**
 * Edge tooltip: shows `kind: from → to` plus the values of each parameter
 * resolved against the currently active model. Endpoints are reduced to
 * their gene names so the header reads cleanly regardless of view (gene
 * vs species).
 */
export function createEdgeTooltip(lookup: ParameterValueLookup): Tooltip {
    return new Tooltip(
        'edge',
        (edge: any) => {
            const kind: string = edge.data('kind') ?? 'unknown'
            const source = String(edge.data('source') ?? '')
            const target = String(edge.data('target') ?? '')
            const header = source && target
                ? `${kind}: ${geneOf(source)} → ${geneOf(target)}`
                : kind
            const params = edge.data('parameters') as Parameter[] | undefined
            const lines = formatParameterLines(params, lookup)
            return lines.length ? `${header}\n${lines.join('\n')}` : header
        },
        'cy-edge-tooltip',
    )
}

/**
 * Derive a friendly reaction name from its `rate` parameter symbol.
 * Cascade reactions have symbols like `gene_1.mrna_decay`; auxiliary
 * reactions have `reaction.<i>.<field>`. Falls back to the raw symbol if
 * the shape is unfamiliar.
 */
function reactionNameFromSymbol(symbol: string | undefined): string | null {
    if (!symbol) return null
    const parts = symbol.split('.')
    if (parts.length === 2) {
        // cascade: gene.kind  →  "kind on gene"
        return `${parts[1]} on ${parts[0]}`
    }
    if (parts.length >= 3 && parts[0] === 'reaction') {
        // auxiliary: reaction.<i>.<field>  →  "reaction <i>" or
        // "reaction <i> (reverse)" when the field is the reverse rate.
        const field = parts[parts.length - 1]
        const reverse = field === 'k⁻' || field === 'k_minus' || field === 'k-'
        return reverse ? `reaction ${parts[1]} (reverse)` : `reaction ${parts[1]}`
    }
    return symbol
}

/**
 * Node tooltip:
 * - Gene nodes show just the name.
 * - Reaction nodes show a derived friendly name (e.g. `mrna_decay on gene_1`)
 *   plus rate value resolved against the active model.
 * - Other nodes (species etc.) show the name.
 */
export function createNodeTooltip(lookup: ParameterValueLookup): Tooltip {
    return new Tooltip(
        'node',
        (node: any) => {
            const kind = String(node.data('kind') ?? '')
            const params = node.data('parameters') as Parameter[] | undefined
            const lines = formatParameterLines(params, lookup)

            const id = String(node.data('id') ?? 'unknown')
            let header: string
            if (kind === 'reaction') {
                const symbol = params?.[0]?.symbol
                header = reactionNameFromSymbol(symbol) ?? id
            } else if (kind === 'gene') {
                header = `gene ${id}`
            } else {
                header = id
            }

            return lines.length ? `${header}\n${lines.join('\n')}` : header
        },
        'cy-node-tooltip',
    )
}
