/**
 * ContextDispatch - resolves right-clicks on the cytoscape canvas into a
 * structured target so callers can show per-target context menus.
 *
 * Dispatch rules:
 *   - cxttap on the canvas background        -> { kind: 'background' }
 *   - cxttap on a regulatory edge (act/rep/  -> { kind: 'reg-edge', id, linkKind }
 *     proteolysis)
 *   - cxttap on a renameable auxiliary        -> { kind: 'reaction', id, reactionName }
 *     reaction node (has a `reaction.<name>.k…` rate)
 *   - cxttap on a species node               -> { kind: 'species', id }
 *     (in species view; lets the user seed/connect auxiliary reactions)
 *   - cxttap on any node inside (or being)   -> { kind: 'gene', id }
 *     a gene compound — we walk up `.parent()` so right-clicking the
 *     gene compound (or a cascade reaction) still surfaces the gene's menu
 *   - anything else                          -> ignored
 *
 * The handler receives the original `MouseEvent` (with `clientX/Y`) for
 * positioning a PrimeVue `ContextMenu`.
 */
import type { Core } from 'cytoscape'
import { reactionNameFromRate } from './reactionName'
import type { ReagentRole } from './actions'

export type ContextTarget =
    /** `position` is in cytoscape model space (where the user right-clicked). */
    | { kind: 'background', position: { x: number, y: number } }
    | { kind: 'gene', id: string }
    /** `id` is the structural node id; `reactionName` the declared name to rename. */
    | { kind: 'reaction', id: string, reactionName: string }
    /** A species node — `id` is its species id (e.g. `A.proteins`, `polymerases`). */
    | { kind: 'species', id: string }
    /** `source`/`target` are the edge's endpoint ids (species-level). */
    | { kind: 'reg-edge', id: string, linkKind: string, source: string, target: string }
    /** A substrate/product edge of an auxiliary reaction — disconnectable. */
    | { kind: 'reagent-edge', reactionName: string, species: string, role: ReagentRole }

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
            if (REGULATORY_EDGE_KINDS.has(linkKind)) {
                return {
                    kind: 'reg-edge',
                    id: String(t.id()),
                    linkKind,
                    source: String(t.data('source')),
                    target: String(t.data('target')),
                }
            }
            if (linkKind === 'substrate' || linkKind === 'product') {
                return this.resolveReagentEdge(t, linkKind)
            }
            return null
        }

        if (typeof t.isNode === 'function' && t.isNode()) {
            // A renameable auxiliary reaction takes precedence over its gene
            // ancestor: its rate symbol carries an editable declared name.
            if (t.data('kind') === 'reaction') {
                const reactionName = reactionNameFromRate(t.data('rate'))
                if (reactionName !== null) {
                    return { kind: 'reaction', id: String(t.id()), reactionName }
                }
            }
            // Species nodes get their own menu (seed/connect auxiliary
            // reactions) rather than deferring to their gene compound.
            if (t.data('kind') === 'species') {
                return { kind: 'species', id: String(t.id()) }
            }
            const gene = findGeneAncestor(t)
            if (gene) return { kind: 'gene', id: String(gene.id()) }
            return null
        }

        return null
    }

    /**
     * Resolve a substrate/product edge to a disconnectable reagent of an
     * auxiliary reaction. A substrate edge runs species→reaction (role
     * `from`); a product edge runs reaction→species (role `to`). Returns null
     * if the reaction endpoint isn't a renameable auxiliary reaction (cascade
     * edges aren't editable).
     */
    private resolveReagentEdge(edge: any, linkKind: string): ContextTarget | null {
        if (!this.cy) return null
        const source = String(edge.data('source'))
        const target = String(edge.data('target'))
        const role: ReagentRole = linkKind === 'substrate' ? 'from' : 'to'
        const species = linkKind === 'substrate' ? source : target
        const reactionNodeId = linkKind === 'substrate' ? target : source
        const reactionName = reactionNameFromRate(
            this.cy.getElementById(reactionNodeId).data('rate'),
        )
        if (reactionName === null) return null
        return { kind: 'reagent-edge', reactionName, species, role }
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
