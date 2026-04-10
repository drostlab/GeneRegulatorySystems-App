/**
 * Lightweight DOM tooltip for Cytoscape elements.
 *
 * Parameterised by selector (e.g. 'edge', 'node') and a content function
 * that extracts tooltip text from the hovered element.
 *
 * @param selector - Cytoscape selector string to attach hover listeners to
 * @param contentFn - extracts display text from a Cytoscape element
 * @param tooltipId - unique DOM id for the tooltip element
 */
import type { Core, EventHandler } from 'cytoscape'

export class Tooltip {
    private cy: Core | null = null
    private tooltip: HTMLDivElement | null = null
    private onMouseOver: EventHandler | null = null
    private onMouseOut: EventHandler | null = null

    /**
     * @param selector - Cytoscape selector (e.g. 'edge', 'node')
     * @param contentFn - returns tooltip text for a given element
     * @param tooltipId - unique DOM id to avoid duplicate tooltips
     */
    private readonly selector: string
    private readonly contentFn: (el: any) => string
    private readonly tooltipId: string

    constructor(selector: string, contentFn: (el: any) => string, tooltipId: string) {
        this.selector = selector
        this.contentFn = contentFn
        this.tooltipId = tooltipId
    }

    /**
     * Attach tooltip listeners to a Cytoscape instance.
     * @param cy - the Cytoscape core instance
     */
    attach(cy: Core): void {
        this.cy = cy
        this.tooltip = this.createTooltipElement()

        this.onMouseOver = (evt: any) => {
            const text = this.contentFn(evt.target)
            this.tooltip!.textContent = text
            this.tooltip!.style.display = 'block'

            const renderedPos = evt.renderedPosition ?? evt.position
            this.tooltip!.style.left = `${renderedPos.x + 12}px`
            this.tooltip!.style.top = `${renderedPos.y - 20}px`
        }

        this.onMouseOut = () => {
            this.tooltip!.style.display = 'none'
        }

        cy.on('mouseover', this.selector, this.onMouseOver)
        cy.on('mouseout', this.selector, this.onMouseOut)
    }

    destroy(): void {
        if (this.cy && this.onMouseOver) {
            this.cy.off('mouseover', this.selector, this.onMouseOver)
        }
        if (this.cy && this.onMouseOut) {
            this.cy.off('mouseout', this.selector, this.onMouseOut)
        }
        this.tooltip?.remove()
        this.tooltip = null
        this.onMouseOver = null
        this.onMouseOut = null
        this.cy = null
    }

    /**
     * Create or re-use the tooltip DOM element.
     * @returns the tooltip div element
     */
    private createTooltipElement(): HTMLDivElement {
        let el = document.getElementById(this.tooltipId) as HTMLDivElement | null
        if (el) return el

        el = document.createElement('div')
        el.id = this.tooltipId
        el.className = 'grs-tooltip'
        Object.assign(el.style, {
            position: 'absolute',
            display: 'none',
            pointerEvents: 'none',
            zIndex: '9999',
        })

        const container = this.cy?.container()
        if (container) {
            container.style.position = 'relative'
            container.appendChild(el)
        } else {
            document.body.appendChild(el)
        }

        return el
    }
}

/** Edge tooltip: shows the edge kind on hover. */
export function createEdgeTooltip(): Tooltip {
    return new Tooltip(
        'edge',
        (edge: any) => edge.data('kind') ?? 'unknown',
        'cy-edge-tooltip',
    )
}

/** Node tooltip: shows the full node name on hover, plus base rates for gene nodes. */
export function createNodeTooltip(): Tooltip {
    return new Tooltip(
        'node',
        (node: any) => {
            const id: string = node.data('id') ?? 'unknown'
            const baseRates: Record<string, number> | undefined = node.data('base_rates')
            if (!baseRates) return id
            const rateLines = Object.entries(baseRates)
                .map(([k, v]) => `  ${k}: ${v}`)
                .join('\n')
            return `${id}\n${rateLines}`
        },
        'cy-node-tooltip',
    )
}
