/**
 * Two-way selection sync between viewerStore and cytoscape.
 *
 * Selection is split by type:
 *   - Gene nodes           → viewerStore.selectedGenes        (drives timeseries fetching)
 *   - Orphan-species nodes → viewerStore.selectedSpeciesNodes (future SpeciesPanel)
 *
 * For dimming/highlighting the network uses a local `visualSelection` that is the
 * union of both, so all logic is uniform — no special-casing per node type.
 */
import type { Core } from 'cytoscape'
import { watch, type WatchStopHandle } from 'vue'
import { useViewerStore } from '@/stores/viewerStore'

export class SelectionSync {
    private cy: Core | null = null
    private stopWatches: WatchStopHandle[] = []
    private updating = false

    /** Local mirror of the visual selection (union of genes + species nodes). */
    private visualSelection = new Set<string>()

    attach(cy: Core): void {
        this.cy = cy
        cy.on('tap', 'node.gene, node.orphan-species', this.onNodeTap)

        const store = useViewerStore()
        this.stopWatches = [
            watch(() => store.selectedGenes, () => this.syncFromStore(), { immediate: true, deep: true }),
            watch(() => store.selectedSpeciesNodes, () => this.syncFromStore(), { deep: true }),
            watch(() => store.selectedOtherSpecies, () => this.syncFromStore(), { deep: true }),
        ]
    }

    destroy(): void {
        this.stopWatches.forEach(s => s())
        this.stopWatches = []
        if (this.cy) {
            this.cy.off('tap', 'node.gene, node.orphan-species', this.onNodeTap)
        }
        this.cy = null
        this.visualSelection.clear()
    }

    /** Re-apply highlighting after elements change. */
    refresh(): void {
        this.syncFromStore()
    }

    // ========================================================================
    // Cytoscape -> Store
    // ========================================================================

    /**
     * Click = solo (select only the tapped node; deselect if already sole selection).
     * Ctrl/Cmd+Click = toggle (add/remove from current selection).
     */
    private onNodeTap = (evt: any): void => {
        if (this.updating) return
        this.updating = true

        const node = evt.target
        const store = useViewerStore()
        const origEvent = evt.originalEvent as MouseEvent | undefined
        const isToggle = origEvent?.ctrlKey === true || origEvent?.metaKey === true

        console.debug(`[SelectionSync] Tap: id=${node.id()} kind=${node.data('kind')} classes=${node.classes()} isToggle=${isToggle}`)

        if (node.data('kind') === 'gene') {
            const id = node.id()
            store.selectedGenes = applySelectionAction(store.selectedGenes, id, isToggle)
        } else {
            // Orphan species: toggle in both selectedSpeciesNodes (network dimming)
            // and selectedOtherSpecies (chart panel fetching)
            const id = node.id()
            store.selectedSpeciesNodes = applySelectionAction(store.selectedSpeciesNodes, id, isToggle)
            store.selectedOtherSpecies = applySelectionAction(store.selectedOtherSpecies, id, isToggle)
        }

        this.updating = false
    }

    // ========================================================================
    // Store -> Cytoscape
    // ========================================================================

    private syncFromStore(): void {
        if (this.updating || !this.cy) return
        this.updating = true

        const cy = this.cy
        const store = useViewerStore()

        // Rebuild local visual selection as union of all store arrays
        this.visualSelection = new Set([
            ...store.selectedGenes,
            ...store.selectedSpeciesNodes,
            ...store.selectedOtherSpecies,
        ])
        const vis = this.visualSelection

        console.debug(`[SelectionSync] syncFromStore: vis=${JSON.stringify([...vis])} genes=${JSON.stringify(store.selectedGenes)} speciesNodes=${JSON.stringify(store.selectedSpeciesNodes)} otherSpecies=${JSON.stringify(store.selectedOtherSpecies)}`)

        cy.startBatch()

        if (vis.size === 0) {
            cy.elements().removeClass('dimmed highlighted')
        } else {
            cy.nodes().forEach((node: any) => {
                const key = resolveSelectable(node)
                const isSelected = key !== null && vis.has(key)
                const isHighlightable = node.data('kind') === 'gene' || node.hasClass('orphan-species')
                if (node.hasClass('orphan-species')) {
                    console.debug(`[SelectionSync] orphan node=${node.id()} key=${key} isSelected=${isSelected} isHighlightable=${isHighlightable}`)
                }
                node.toggleClass('highlighted', isSelected && isHighlightable)
                node.toggleClass('dimmed', !isSelected)
            })

            cy.edges().forEach((edge: any) => {
                const srcKey = resolveSelectable(cy.getElementById(edge.data('source')))
                const tgtKey = resolveSelectable(cy.getElementById(edge.data('target')))
                const srcSelected = srcKey !== null && vis.has(srcKey)
                const tgtSelected = tgtKey !== null && vis.has(tgtKey)
                // Regulatory/tree edges: only lit when BOTH endpoints selected.
                // Reaction edges (substrate/product): lit when either endpoint selected.
                const kind = edge.data('kind') as string
                const isReactionEdge = kind === 'substrate' || kind === 'product'
                const isConnected = isReactionEdge
                    ? srcSelected || tgtSelected
                    : srcSelected && tgtSelected
                edge.toggleClass('dimmed', !isConnected)
            })
        }

        cy.endBatch()
        this.updating = false
    }
}

/**
 * Resolve a Cytoscape node to its selection key:
 *   - gene node       → gene id (own id)
 *   - child species   → gene parent id
 *   - orphan species  → own id
 *   - other / empty   → null
 */
function resolveSelectable(node: any): string | null {
    if (!node || node.empty()) return null
    const kind = node.data('kind')
    if (kind === 'gene') return node.id()
    if (node.hasClass('orphan-species')) return node.id()
    const parent = node.data('geneParent')
    if (parent) return parent
    return null
}

/**
 * Apply click-to-solo / Ctrl+Click-to-toggle logic.
 *   - Solo: replace selection with [id], or clear if id was the sole selection.
 *   - Toggle: add id if absent, remove if present.
 */
function applySelectionAction(current: string[], id: string, isToggle: boolean): string[] {
    if (isToggle) {
        return current.includes(id)
            ? current.filter(g => g !== id)
            : [...current, id]
    }
    // Solo
    if (current.length === 1 && current[0] === id) {
        return []
    }
    return [id]
}
