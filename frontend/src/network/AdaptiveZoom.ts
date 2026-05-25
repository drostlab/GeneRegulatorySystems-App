/**
 * Adaptive zoom: toggles between gene-level and species-level views.
 *
 * Below the zoom threshold, the gene view is shown:
 *   - Gene nodes, orphan species, and gene-scope + resolved-all edges.
 * Above the threshold, the species view is added:
 *   - Species/reaction nodes as compound children of genes,
 *     species-scope + all-scope edges at actual endpoints.
 *   - Gene-scope edges are removed, all-scope edges are swapped
 *     from gene-resolved endpoints to species-level endpoints.
 *   - Regulatory edges get `.species-view` class (thin, no label).
 *   - Gene nodes get `.compound-parent` class (transparent bg).
 *   - A scoped fcose layout runs on species/reaction nodes (genes locked).
 *
 * Gene positions are saved/restored across transitions to prevent
 * compound layout shifts.
 */
import type { Core, EventHandler } from 'cytoscape'
import type { UnionNetwork } from '@/types/network'
import { getGeneViewElements, getSpeciesViewElements } from './networkElements'
import { darken, lighten } from '@/utils/colorUtils'
import logging from '@/utils/logging'

const log = logging.getLogger('AdaptiveZoom')

/** Zoom level above which species/reactions become visible. */
const ZOOM_THRESHOLD = 2.0

/** Debounce for zoom event handling. */
const DEBOUNCE_MS = 50

/** Regulatory edge kinds that get thinned in species view. */
const REGULATORY_KINDS = new Set(['activation', 'repression', 'proteolysis'])

/** Known cascade species types — pinned during layout refinement. */
const CASCADE_SPECIES = new Set([
    'active', 'inactive', 'elongations', 'premrnas', 'mrnas', 'proteins',
])

/**
 * Hardcoded zigzag offsets for known cascade species (relative to a virtual
 * gene-interior origin). Values are tuned for visual layout, not centroid
 * balance — `seedChildPositions` re-centres the actual subset present so the
 * compound parent stays put regardless of which species exist.
 */
const SPECIES_OFFSETS: Record<string, { x: number; y: number }> = {
    inactive:    { x: -45, y:  -5 },
    active:      { x: -30, y: -15 },
    elongations: { x: -20, y:   5 },
    premrnas:    { x:   0, y:  15 },
    mrnas:       { x:  25, y:  10 },
    proteins:    { x:  30, y: -15 },
}

export class AdaptiveZoom {
    private cy: Core | null = null
    private network: UnionNetwork | null = null
    private geneColours: Record<string, string> = {}
    private isDark = false
    private detailVisible = false
    private manualOverride = false
    private timeout: ReturnType<typeof setTimeout> | null = null
    private handler: EventHandler | null = null

    /** Precomputed element sets for fast toggling. */
    private geneViewEdges: cytoscape.ElementDefinition[] = []
    private speciesViewElements: cytoscape.ElementDefinition[] = []

    /**
     * Positions of species/reaction nodes from the previous species-view
     * session. Populated on hideDetail, consumed on the next showDetail to
     * skip seeding + per-gene fcose, so toggling preserves user-visible layout.
     */
    private cachedChildPositions = new Map<string, { x: number; y: number }>()

    /**
     * Genes that have already been laid out by per-gene fcose at least once.
     * Cached positions are only honoured for these — genes that were merely
     * offset-seeded (because they were off-viewport during a previous
     * showDetail) still need a real fcose pass next time they come into view.
     */
    private fcosedGenes = new Set<string>()

    /** Callback fired when detail visibility changes. */
    onDetailChange: ((visible: boolean) => void) | null = null

    /**
     * Attach to a Cytoscape instance and start monitoring zoom.
     *
     * Precomputes both gene-view and species-view element sets for
     * fast toggling without re-running element generation.
     *
     * @param cy - Cytoscape core instance
     * @param network - union network data from backend
     * @param geneColours - gene name to colour mapping
     */
    attach(cy: Core, network: UnionNetwork, geneColours: Record<string, string>, isDark = false): void {
        this.cy = cy
        this.network = network
        this.geneColours = geneColours
        this.isDark = isDark
        this.detailVisible = false

        // Precompute elements for both views
        this.precomputeElements()

        this.handler = () => this.scheduleCheck()
        cy.on('zoom', this.handler)

        // Initial check: if the post-layout fit already zoomed past the
        // threshold (small networks tend to), switch to species view now —
        // no zoom event will fire on its own to trigger it. Defer past the
        // layout's fit animation so the zoom value has settled.
        setTimeout(() => {
            if (this.cy === cy) this.checkZoom()
        }, 500)
    }

    /**
     * Rebuild cached elements with updated theme and update theme-derived
     * data fields on live nodes that won't be re-added: reactions'
     * `parentColour` (in `speciesViewElements`) and genes' `compoundColour`
     * (genes are live cytoscape nodes from the initial setNetwork, not in
     * `speciesViewElements`).
     */
    applyTheme(isDark: boolean): void {
        this.isDark = isDark
        this.precomputeElements()
        if (!this.cy) return

        // Genes: recompute compoundColour from their persistent `colour` data,
        // since they're long-lived cytoscape nodes not tracked in any cached
        // element array.
        this.cy.nodes('.gene').forEach((node: any) => {
            const colour = node.data('colour')
            if (typeof colour !== 'string') return
            const compoundColour = isDark ? darken(colour, 0.3) : lighten(colour, 0.7)
            node.data('compoundColour', compoundColour)
        })

        // Reactions (and any other species-view-only nodes): pull updated
        // theme-derived fields from the freshly-precomputed elements array.
        for (const el of this.speciesViewElements) {
            if (!el.data?.id) continue
            const node = this.cy.getElementById(el.data.id as string)
            if (!node.nonempty()) continue
            if (el.data.kind === 'reaction' && el.data.parentColour) {
                node.data('parentColour', el.data.parentColour)
            }
        }
    }

    destroy(): void {
        if (this.timeout) {
            clearTimeout(this.timeout)
            this.timeout = null
        }
        if (this.cy && this.handler) {
            this.cy.off('zoom', this.handler)
        }
        this.handler = null
        this.cy = null
        this.network = null
        this.geneViewEdges = []
        this.speciesViewElements = []
        this.cachedChildPositions.clear()
        this.fcosedGenes.clear()
        this.manualOverride = false
    }

    get isDetailVisible(): boolean {
        return this.detailVisible
    }

    /**
     * Manually toggle between gene and species views.
     * Sets manualOverride so auto-zoom doesn't immediately undo the toggle.
     * Override clears on the next zoom crossing so natural zooming resumes.
     */
    toggleDetail(): void {
        if (!this.cy || !this.network) return
        this.manualOverride = true
        if (this.detailVisible) {
            this.hideDetail()
        } else {
            this.showDetail()
        }
    }

    // ========================================================================
    // Precomputation
    // ========================================================================

    /**
     * Precompute element sets for both zoom levels.
     * Gene-view edges are stored separately for removal/re-adding on toggle.
     */
    private precomputeElements(): void {
        if (!this.network) return

        // Gene-view: extract only edges (nodes are already in the graph)
        const geneView = getGeneViewElements(this.network, this.geneColours, this.isDark)
        this.geneViewEdges = geneView.filter(e => e.data.source !== undefined)

        // Species-view: all nodes + edges
        this.speciesViewElements = getSpeciesViewElements(this.network, this.geneColours, this.isDark)

        log.debug(
            `Precomputed: ${this.geneViewEdges.length} gene edges, ` +
            `${this.speciesViewElements.length} species elements`,
        )
    }

    // ========================================================================
    // Zoom handling
    // ========================================================================

    private scheduleCheck(): void {
        if (this.timeout) clearTimeout(this.timeout)
        this.timeout = setTimeout(() => this.checkZoom(), DEBOUNCE_MS)
    }

    private checkZoom(): void {
        const cy = this.cy
        if (!cy || !this.network) return

        const shouldShow = cy.zoom() > ZOOM_THRESHOLD

        // After a manual toggle, suppress until zoom crosses back to the
        // matching side (so the immediate zoom event doesn't undo the toggle).
        if (this.manualOverride) {
            if (shouldShow === this.detailVisible) {
                // Zoom now agrees with the manual state — resume auto-switching
                this.manualOverride = false
            }
            return
        }

        if (shouldShow === this.detailVisible) return

        if (shouldShow) {
            this.showDetail()
        } else {
            this.hideDetail()
        }
    }

    // ========================================================================
    // View transitions
    // ========================================================================

    /**
     * Transition to species-level view.
     *
     * 1. Save gene positions
     * 2. Remove gene-scope edges
     * 3. Add species nodes + species-scope + all-scope edges
     * 4. Seed child positions (using saved gene centres — before batch end!)
     * 5. Tag regulatory edges with .species-view, genes with .compound-parent
     * 6. Run per-gene fcose refinement on free (non-cascade) nodes
     */
    private showDetail(): void {
        const cy = this.cy!
        if (this.speciesViewElements.length === 0) return

        const genePositions = this.saveGenePositions()

        cy.startBatch()

        // Remove gene-view edges
        const geneEdgeIds = new Set(this.geneViewEdges.map(e => e.data.id as string))
        cy.edges().forEach((edge: any) => {
            if (geneEdgeIds.has(edge.id())) edge.remove()
        })

        // Add species-view elements, skipping already-present ones
        const existing = new Set(cy.elements().map((e: any) => e.id()))
        const newElements = this.speciesViewElements.filter(
            e => !existing.has(e.data.id as string),
        )
        if (newElements.length > 0) {
            cy.add(newElements)
        }

        // Seed children at known positions BEFORE ending batch.
        // This is critical: once children exist, gene becomes a compound node
        // whose position is derived from children. We must place children at
        // the saved gene centre so the compound doesn't drift.
        this.seedChildPositions(genePositions)

        // Tag gene nodes as compound parents (transparent bg via stylesheet)
        cy.nodes('.gene').addClass('compound-parent')

        // Tag regulatory edges with species-view class (thin, no label),
        // but only when at least one endpoint is a species/reaction node.
        // Gene-level edges (connecting flat genes) keep their normal styling.
        cy.edges().forEach((edge: any) => {
            if (!REGULATORY_KINDS.has(edge.data('kind'))) return
            const src = cy.getElementById(edge.data('source'))
            const tgt = cy.getElementById(edge.data('target'))
            if (src.hasClass('species') || src.hasClass('reaction')
                || tgt.hasClass('species') || tgt.hasClass('reaction')) {
                edge.addClass('species-view')
            }
        })

        cy.endBatch()
        this.cachedChildPositions.clear()

        // Snap each gene back to its pre-transition centre. Must run AFTER
        // endBatch — cytoscape only resolves compound positions after the
        // batch ends, so `gene.position()` is reliable here. For cache-
        // restored genes the drift is zero, so this is a no-op.
        cy.nodes('.gene').forEach((gene: any) => {
            const centre = genePositions.get(gene.id())
            if (centre) this.recentreCompound(gene, centre)
        })

        // Run per-gene physics refinement for non-cascade nodes
        this.runSpeciesLayout(() => {
            this.detailVisible = true
            this.onDetailChange?.(true)
        })
    }

    /**
     * Transition back to gene-level view.
     *
     * 1. Save gene positions
     * 2. Remove species/reaction nodes + species-view edges
     * 3. Remove .species-view and .compound-parent classes
     * 4. Re-add gene-scope edges
     * 5. Restore gene positions
     */
    private hideDetail(): void {
        const cy = this.cy!

        const genePositions = this.saveGenePositions()

        // Snapshot species/reaction positions so the next showDetail can
        // skip seeding + fcose and restore the exact same layout.
        this.cachedChildPositions.clear()
        cy.nodes('.species, .reaction').forEach((n: any) => {
            const p = n.position()
            this.cachedChildPositions.set(n.id(), { x: p.x, y: p.y })
        })

        cy.startBatch()

        // Remove species/reaction nodes (cascade removes connected edges)
        cy.nodes('.species, .reaction').remove()

        // Remove any remaining species-view edges
        const speciesEdgeIds = new Set(
            this.speciesViewElements
                .filter(e => e.data.source !== undefined)
                .map(e => e.data.id as string),
        )
        cy.edges().forEach((edge: any) => {
            if (speciesEdgeIds.has(edge.id())) edge.remove()
        })

        // Re-add gene-view edges
        const existingAfter = new Set(cy.elements().map((e: any) => e.id()))
        const geneEdges = this.geneViewEdges.filter(
            e => !existingAfter.has(e.data.id as string),
        )
        if (geneEdges.length > 0) {
            cy.add(geneEdges)
        }

        // Remove view-specific CSS classes
        cy.nodes('.gene').removeClass('compound-parent')
        cy.edges().removeClass('species-view')

        this.restoreGenePositions(genePositions)

        cy.endBatch()

        this.detailVisible = false
        this.onDetailChange?.(false)
    }

    // ========================================================================
    // Position helpers
    // ========================================================================

    /**
     * Translate every child of `gene` by `target - gene.position()`. Because
     * the compound parent's position is a linear function of its children's
     * positions (cytoscape uses the children's bbox centre), uniformly
     * shifting every child by Δ shifts the compound by Δ exactly — formula-
     * independent. Used to snap the gene back to its pre-transition / pre-
     * layout position after children have been added or moved.
     *
     * IMPORTANT: must be called OUTSIDE any active cy.startBatch/endBatch.
     * Inside a batch, cytoscape defers compound-position recomputation, so
     * `gene.position()` is stale and the measured drift is wrong.
     */
    private recentreCompound(gene: any, target: { x: number; y: number }): void {
        const cur = gene.position()
        const dx = target.x - cur.x
        const dy = target.y - cur.y
        if (dx === 0 && dy === 0) return
        gene.children().forEach((c: any) => {
            const p = c.position()
            c.position({ x: p.x + dx, y: p.y + dy })
        })
    }

    /** Save positions of all gene and orphan-species nodes. */
    private saveGenePositions(): Map<string, { x: number; y: number }> {
        const positions = new Map<string, { x: number; y: number }>()
        this.cy!.nodes('.gene, .orphan-species').forEach((n: any) => {
            const pos = n.position()
            positions.set(n.id(), { x: pos.x, y: pos.y })
        })
        return positions
    }

    /** Restore saved gene/orphan-species positions. */
    private restoreGenePositions(positions: Map<string, { x: number; y: number }>): void {
        positions.forEach((pos, id) => {
            const node = this.cy!.getElementById(id)
            if (!node.empty()) {
                node.position(pos)
            }
        })
    }

    /**
     * Per-gene physics refinement.
     *
     * For each visible gene, collect its children + intra-gene edges and run
     * a short fcose pass.  Known cascade species (active, elongations, etc.)
     * are pinned via fixedNodeConstraint; only unknown/custom species and
     * reactions are free to move.  This keeps the zigzag cascade stable while
     * letting extra nodes (e.g. homodimers) find good positions.
     *
     * @param onDone - callback when all per-gene layouts complete
     */
    private runSpeciesLayout(onDone: () => void): void {
        const cy = this.cy!

        // Only lay out genes in/near the viewport that haven't already been
        // fcose'd in a previous session — those keep their cached positions.
        const ext = cy.extent()
        const pad = 200
        const visibleGenes = cy.nodes('.gene').filter((gene: any) => {
            if (this.fcosedGenes.has(gene.id())) return false
            const pos = gene.position()
            return pos.x >= ext.x1 - pad && pos.x <= ext.x2 + pad
                && pos.y >= ext.y1 - pad && pos.y <= ext.y2 + pad
        })

        if (visibleGenes.empty()) {
            onDone()
            return
        }

        let remaining = visibleGenes.length
        const done = () => {
            remaining--
            if (remaining <= 0) {
                // All per-gene layouts complete — now place orphan reactions
                // against their final (post-layout) neighbour positions.
                this.runOrphanReactionLayout(onDone)
            }
        }

        visibleGenes.forEach((gene: any) => {
            const children = gene.children()
            if (children.empty()) {
                done()
                return
            }

            // Snapshot the position we want to preserve across the fcose pass.
            const targetCentre = { x: gene.position().x, y: gene.position().y }

            // Collect intra-gene edges (both endpoints are children of this gene)
            const childIds = new Set<string>()
            children.forEach((c: any) => childIds.add(c.id()))
            const intraEdges = cy.edges().filter((edge: any) => {
                return childIds.has(edge.data('source')) && childIds.has(edge.data('target'))
            })

            // Pin known cascade species at their current (seeded) positions
            const fixedConstraints: Array<{ nodeId: string; position: { x: number; y: number } }> = []
            children.forEach((child: any) => {
                const speciesType = child.data('species_type') as string | undefined
                if (speciesType && CASCADE_SPECIES.has(speciesType)) {
                    const pos = child.position()
                    fixedConstraints.push({ nodeId: child.id(), position: { x: pos.x, y: pos.y } })
                }
            })

            const elements = children.merge(intraEdges)

            const layout = elements.layout({
                name: 'fcose',
                quality: 'default',
                randomize: false,
                animate: false,
                fit: false,
                fixedNodeConstraint: fixedConstraints.length > 0 ? fixedConstraints : undefined,
                nodeRepulsion: 1000,
                idealEdgeLength: 0.5,
                edgeElasticity: 0.9,
                numIter: 100,
                gravity: 1.2,
                gravityRange: 1.0,
                tile: false,
                packComponents: false,
            } as any)

            layout.one('layoutstop', () => {
                // fcose moved children — translate the whole subtree back so
                // the compound parent returns to its pre-layout position.
                this.recentreCompound(gene, targetCentre)
                this.fcosedGenes.add(gene.id())
                done()
            })
            layout.run()
        })
    }

    /**
     * Separate physics pass for orphan reaction nodes (reactions with no gene parent).
     * Uses relaxed spring parameters — longer ideal edge length and lower elasticity —
     * so they spread naturally away from gene clusters. All neighbouring gene /
     * orphan-species nodes are pinned to prevent pulling the main layout.
     */
    private runOrphanReactionLayout(onDone?: () => void): void {
        const cy = this.cy!

        const orphanReactions = cy.nodes('.reaction').filter((n: any) => !n.data('parent'))
        if (orphanReactions.empty()) {
            onDone?.()
            return
        }

        // Collect the orphan reactions + all edges attached to them
        const orphanIds = new Set<string>()
        orphanReactions.forEach((n: any) => { orphanIds.add(n.id()) })

        const attachedEdges = cy.edges().filter((e: any) =>
            orphanIds.has(e.data('source')) || orphanIds.has(e.data('target'))
        )

        // Include neighbour nodes so edge lengths make sense, but pin them
        const neighbourNodes = orphanReactions.neighborhood('node').not(orphanReactions)
        const fixedConstraints: Array<{ nodeId: string; position: { x: number; y: number } }> = []
        neighbourNodes.forEach((n: any) => {
            const pos = n.position()
            fixedConstraints.push({ nodeId: n.id(), position: { x: pos.x, y: pos.y } })
        })

        const elements = orphanReactions.merge(neighbourNodes).merge(attachedEdges)

        const layout = elements.layout({
            name: 'fcose',
            quality: 'default',
            randomize: false,
            animate: false,
            fit: false,
            fixedNodeConstraint: fixedConstraints.length > 0 ? fixedConstraints : undefined,
            nodeRepulsion: 3000,
            idealEdgeLength: 60,
            edgeElasticity: 0.3,
            numIter: 150,
            gravity: 0.4,
            gravityRange: 2.0,
            tile: false,
            packComponents: false,
        } as any)

        if (onDone) layout.one('layoutstop', onDone)
        layout.run()
    }

    /**
     * Seed species/reaction children at deterministic positions relative to
     * their gene's saved centre.
     *
     * Known cascade species get hardcoded zigzag offsets:
     *   active -> elongations -> premrnas -> mrnas -> proteins
     * Reactions are placed at the centroid of their connected species.
     * Unknown species get small offsets below the cascade.
     *
     * Uses savedPositions (not gene.position()) because once children exist
     * the gene becomes a compound node whose position is derived from children.
     *
     * @param savedPositions - gene positions captured before children were added
     */
    private seedChildPositions(savedPositions: Map<string, { x: number; y: number }>): void {
        const cy = this.cy!

        cy.nodes('.gene').forEach((gene: any) => {
            const children = gene.children()
            if (children.empty()) return

            const center = savedPositions.get(gene.id())
            if (!center) return

            // Fast path: gene was already laid out by fcose in a previous
            // session AND every child has a cached position. Restore exactly
            // and let runSpeciesLayout skip this gene.
            const allCached = this.fcosedGenes.has(gene.id())
                && children.every((c: any) => this.cachedChildPositions.has(c.id()))
            if (allCached) {
                children.forEach((c: any) => {
                    const p = this.cachedChildPositions.get(c.id())!
                    c.position({ x: p.x, y: p.y })
                })
                return
            }

            let unknownIndex = 0

            // Pass 1: place species at their offsets relative to `center`.
            children.forEach((child: any) => {
                if (child.data('kind') !== 'species') return
                const speciesType = child.data('species_type') as string | undefined
                const offset = speciesType ? SPECIES_OFFSETS[speciesType] : undefined
                if (offset) {
                    child.position({ x: center.x + offset.x, y: center.y + offset.y })
                } else {
                    child.position({ x: center.x - 20 + unknownIndex * 15, y: center.y + 25 })
                    unknownIndex++
                }
            })

            // Pass 2: reactions at the centroid of their connected species.
            children.forEach((child: any) => {
                if (child.data('kind') !== 'reaction') return
                const neighbours = child.neighborhood('node')
                if (neighbours.empty()) {
                    child.position({ x: center.x, y: center.y + 15 })
                    return
                }
                let sx = 0, sy = 0, n = 0
                neighbours.forEach((nb: any) => {
                    const p = nb.position()
                    sx += p.x; sy += p.y; n++
                })
                if (n === 1) {
                    const np = neighbours.first().position()
                    const dx = np.x - center.x, dy = np.y - center.y
                    const dist = Math.hypot(dx, dy)
                    if (dist > 0.1) {
                        child.position({ x: np.x - (dy / dist) * 8, y: np.y + (dx / dist) * 8 })
                    } else {
                        child.position({ x: np.x + 5, y: np.y })
                    }
                } else {
                    child.position({ x: sx / n, y: sy / n })
                }
            })

            // NOTE: don't recentre here — caller does it after endBatch.
        })

        // Orphan reactions: restore cached position if any, otherwise place
        // near first connected neighbour.
        cy.nodes('.reaction').forEach((node: any) => {
            if (node.data('parent')) return
            const cached = this.cachedChildPositions.get(node.id())
            if (cached) {
                node.position({ x: cached.x, y: cached.y })
                return
            }
            const neighbours = node.neighborhood('node')
            if (neighbours.empty()) return
            const nPos = neighbours.first().position()
            node.position({ x: nPos.x + 15, y: nPos.y + 10 })
        })
    }
}
