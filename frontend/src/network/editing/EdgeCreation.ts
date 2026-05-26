/**
 * EdgeCreation - thin wrapper around `cytoscape-edgehandles`.
 *
 * Lets the caller start an interactive "draw a new link" gesture from a
 * source node, with the desired link kind (activation / repression /
 * proteolysis) carried through to the completion callback.
 *
 * We do NOT let edgehandles add the new edge to the graph itself — its
 * auto-added preview edge is removed in `ehcomplete`, and the actual
 * mutation is left to the EditAction consumer (which will round-trip
 * through the backend before any visual change lands).
 */
import type { Core } from 'cytoscape'
import cytoscape from 'cytoscape'
// @ts-ignore - no types shipped
import edgehandlesExt from 'cytoscape-edgehandles'
import type { LinkKind } from './actions'
import { getEdgeColour } from '../networkStyles'

cytoscape.use(edgehandlesExt)

export type EdgeCompleteHandler = (
    source: string,
    target: string,
    kind: LinkKind,
) => void

export class EdgeCreation {
    private cy: Core | null = null
    private eh: any = null
    private kind: LinkKind | null = null
    private handler: EdgeCompleteHandler | null = null
    private onComplete: ((event: any, sourceNode: any, targetNode: any, addedEdge: any) => void) | null = null
    private onCancel: (() => void) | null = null

    set onEdgeComplete(cb: EdgeCompleteHandler | null) {
        this.handler = cb
    }

    attach(cy: Core): void {
        this.cy = cy
        this.eh = (cy as any).edgehandles({
            // Only genes can be link endpoints. Self-loops are allowed
            // (autoregulation is a real biological pattern).
            canConnect: (_source: any, target: any) =>
                target.data('kind') === 'gene',
            snap: true,
            snapThreshold: 50,
            snapFrequency: 15,
            noEdgeEventsInDraw: true,
            disableBrowserGestures: true,
            // Stamp `kind` AND `edgeColour` onto the preview edge so the
            // existing `edge[kind=...]` rules (arrow shape, width) and
            // `edge[edgeColour]` rules (line/arrow colour) all apply
            // mid-draw. Without `edgeColour` the preview line is grey
            // even though the arrow head is the right colour.
            edgeParams: () => this.kind
                ? { data: { kind: this.kind, edgeColour: getEdgeColour(this.kind) } }
                : {},
        })

        this.onComplete = (_evt: any, _src: any, _tgt: any, addedEdge: any) => {
            const sourceId = String(_src.id())
            const targetId = String(_tgt.id())
            const kind = this.kind

            // edgehandles auto-adds a real edge — strip it so the graph
            // mutation comes only via the EditAction round-trip.
            if (addedEdge?.remove) addedEdge.remove()

            // Clear drawing state AFTER the synchronous tap that completes
            // the gesture finishes propagating — otherwise SelectionSync's
            // tap handler (which also fires for this tap) would see the
            // flag already cleared and select the target gene.
            requestAnimationFrame(() => this.clearDrawing())

            if (kind && this.handler) {
                this.handler(sourceId, targetId, kind)
            }
        }
        this.onCancel = () => {
            requestAnimationFrame(() => this.clearDrawing())
        }

        cy.on('ehcomplete', this.onComplete)
        cy.on('ehcancel ehstop', this.onCancel)
    }

    startDraw(sourceId: string, kind: LinkKind): void {
        if (!this.cy || !this.eh) return
        const node = this.cy.getElementById(sourceId)
        if (!node || node.empty()) return
        this.kind = kind
        // Visible across modules via `cy.scratch('grs_drawing')`. SelectionSync
        // reads it to ignore the tap that completes an edge draw.
        this.cy.scratch('grs_drawing', true)
        this.eh.start(node)
    }

    private clearDrawing(): void {
        this.kind = null
        this.cy?.scratch('grs_drawing', false)
    }

    destroy(): void {
        if (this.cy) {
            if (this.onComplete) this.cy.off('ehcomplete', this.onComplete)
            if (this.onCancel) this.cy.off('ehcancel ehstop', this.onCancel)
        }
        if (this.eh?.destroy) this.eh.destroy()
        this.cy = null
        this.eh = null
        this.kind = null
        // Note: `handler` is owned by the caller (set once via NetworkView's
        // `onEditAction`), so we don't null it — setNetwork's teardown/rebuild
        // cycle would otherwise clear it.
        this.onComplete = null
        this.onCancel = null
    }
}
