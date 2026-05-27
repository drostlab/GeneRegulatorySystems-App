/**
 * ContextDispatch - resolves right-clicks on the cytoscape canvas into a
 * structured target so callers can show per-target context menus.
 *
 * Dispatch rules:
 *   - cxttap on the canvas background        -> { kind: 'background' }
 *   - cxttap on a regulatory edge (act/rep/  -> { kind: 'reg-edge', id, linkKind }
 *     proteolysis)
 *   - cxttap on any node inside (or being)   -> { kind: 'gene', id }
 *     a gene compound — we walk up `.parent()` so right-clicking the
 *     species/reactions inside a gene still surfaces the gene's menu
 *   - anything else                          -> ignored
 *
 * The handler receives the original `MouseEvent` (with `clientX/Y`) for
 * positioning a PrimeVue `ContextMenu`.
 */
import type { Core } from 'cytoscape'

export type ContextTarget =
    /** `position` is in cytoscape model space (where the user right-clicked). */
    | { kind: 'background', position: { x: number, y: number } }
    | { kind: 'gene', id: string }
    /** `source`/`target` are the edge's endpoint ids (species-level). */
    | { kind: 'reg-edge', id: string, linkKind: string, source: string, target: string }

const REGULATORY_EDGE_KINDS = new Set(['activation', 'repression', 'proteolysis'])

export type ContextMenuHandler = (target: ContextTarget, evt: MouseEvent) => void

export class ContextDispatch {
    private cy: Core | null = null
    private handler: ContextMenuHandler | null = null
    private onCxtTap: ((evt: any) => void) | null = null

    set onContextMenu(cb: ContextMenuHandler | null) {
        this.handler = cb
    }

    attach(cy: Core): void {
        this.cy = cy
        this.onCxtTap = (evt: any) => this.dispatch(evt)
        cy.on('cxttap', this.onCxtTap)
    }

    destroy(): void {
        if (this.cy && this.onCxtTap) {
            this.cy.off('cxttap', this.onCxtTap)
        }
        this.cy = null
        this.onCxtTap = null
        // Note: `handler` is owned by the caller (set once via `onContextMenu`
        // on NetworkView before any setNetwork), so we don't null it here —
        // setNetwork's teardown/rebuild cycle would otherwise clear it.
    }

    private dispatch(evt: any): void {
        if (!this.handler) return
        const oe = evt.originalEvent as MouseEvent | undefined
        if (!oe) return

        const target = this.resolve(evt)
        if (!target) return

        oe.preventDefault?.()
        this.handler(target, oe)
    }

    private resolve(evt: any): ContextTarget | null {
        const t = evt.target
        if (!t || t === this.cy) {
            const p = evt.position ?? { x: 0, y: 0 }
            return { kind: 'background', position: { x: p.x, y: p.y } }
        }

        if (typeof t.isEdge === 'function' && t.isEdge()) {
            const linkKind = String(t.data('kind') ?? '')
            if (!REGULATORY_EDGE_KINDS.has(linkKind)) return null
            return {
                kind: 'reg-edge',
                id: String(t.id()),
                linkKind,
                source: String(t.data('source')),
                target: String(t.data('target')),
            }
        }

        if (typeof t.isNode === 'function' && t.isNode()) {
            const gene = findGeneAncestor(t)
            if (gene) return { kind: 'gene', id: String(gene.id()) }
            return null
        }

        return null
    }
}

/**
 * Walk `node` and its parent chain looking for a gene compound. Returns
 * the gene node if found — covers both "right-click directly on the gene
 * compound" and "right-click on a species/reaction inside a gene."
 */
function findGeneAncestor(node: any): any | null {
    let cur = node
    while (cur && cur.nonempty?.()) {
        if (cur.data?.('kind') === 'gene') return cur
        cur = cur.parent?.()
    }
    return null
}
