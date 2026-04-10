/**
 * HoverSync -- bidirectional gene hover sync between Cytoscape and viewerStore.
 *
 * Network -> Store: mouseover/mouseout on gene nodes sets hoveredGeneId.
 * Store -> Network: watches hoveredGeneId and toggles `.gene-hover` class
 *   on the corresponding node (e.g. when timeseries panels trigger hover).
 *
 * A `fromCy` guard prevents circular events.
 */
import type { Core } from 'cytoscape'
import { watch, type WatchStopHandle } from 'vue'
import { useViewerStore } from '@/stores/viewerStore'

export class HoverSync {
    private cy: Core | null = null
    private stopWatch: WatchStopHandle | null = null
    /** Guard: true while a Cytoscape event is propagating to the store. */
    private fromCy = false
    /** Currently highlighted gene id in the network (for cleanup). */
    private currentHighlight: string | null = null

    attach(cy: Core): void {
        this.cy = cy
        cy.on('mouseover', 'node.gene', this.onMouseOver)
        cy.on('mouseout', 'node.gene', this.onMouseOut)

        const store = useViewerStore()
        this.stopWatch = watch(
            () => store.hoveredGeneId,
            (gene) => this.syncToNetwork(gene),
        )
    }

    destroy(): void {
        this.stopWatch?.()
        this.stopWatch = null
        if (this.cy) {
            this.cy.off('mouseover', 'node.gene', this.onMouseOver)
            this.cy.off('mouseout', 'node.gene', this.onMouseOut)
            this._clearHighlight()
        }
        this.cy = null
        useViewerStore().setHoveredGene(null)
    }

    // ── Cytoscape -> Store ──────────────────────────────────────────────

    private onMouseOver = (evt: any): void => {
        const geneId = evt.target.id() as string
        this.fromCy = true
        console.debug(`[HoverSync] mouseover gene=${geneId}`)
        useViewerStore().setHoveredGene(geneId)
        this.fromCy = false
    }

    private onMouseOut = (_evt: any): void => {
        this.fromCy = true
        console.debug('[HoverSync] mouseout gene')
        useViewerStore().setHoveredGene(null)
        this.fromCy = false
    }

    // ── Store -> Cytoscape ──────────────────────────────────────────────

    private syncToNetwork(gene: string | null): void {
        if (this.fromCy || !this.cy) return
        this._clearHighlight()
        if (gene) {
            const node = this.cy.getElementById(gene)
            if (node && !node.empty()) {
                node.addClass('gene-hover')
                this.currentHighlight = gene
                console.debug(`[HoverSync] highlight network node=${gene}`)
            }
        }
    }

    private _clearHighlight(): void {
        if (this.currentHighlight && this.cy) {
            this.cy.getElementById(this.currentHighlight).removeClass('gene-hover')
            this.currentHighlight = null
        }
    }
}
