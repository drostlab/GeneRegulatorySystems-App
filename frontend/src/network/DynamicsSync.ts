/**
 * Dynamic node sizing based on simulation protein counts.
 *
 * Watches viewerStore.proteinCountsAtTimepoint and scales gene node
 * padding proportionally within COMPOUND_PADDING_RANGE. Works in both
 * gene view (non-compound) and species view (compound-parent).
 * Debounced at ~60fps.
 */
import type { Core } from 'cytoscape'
import { watch, type WatchStopHandle } from 'vue'
import { useViewerStore } from '@/stores/viewerStore'
import { COMPOUND_PADDING_RANGE } from './networkStyles'

const DEBOUNCE_MS = 16

export class DynamicsSync {
    private cy: Core | null = null
    private stopWatch: WatchStopHandle | null = null
    private timeout: ReturnType<typeof setTimeout> | null = null

    attach(cy: Core): void {
        this.cy = cy

        const viewerStore = useViewerStore()
        this.stopWatch = watch(
            () => [viewerStore.proteinCountsAtTimepoint, viewerStore.selectedGenes],
            () => this.scheduleUpdate(),
            { deep: true },
        )
    }

    destroy(): void {
        this.stopWatch?.()
        this.stopWatch = null
        if (this.timeout) {
            clearTimeout(this.timeout)
            this.timeout = null
        }
        this.cy = null
    }

    /** Reset all gene nodes to base padding. */
    resetSizes(): void {
        if (!this.cy) return
        this.cy.startBatch()
        this.cy.nodes('.gene').forEach((node: any) => node.removeStyle('padding'))
        this.cy.endBatch()
    }

    /** Called when the detail view (species/gene) changes so sizing is reapplied. */
    notifyDetailChanged(_visible: boolean): void {
        this.scheduleUpdate()
    }

    private scheduleUpdate(): void {
        if (this.timeout) clearTimeout(this.timeout)
        this.timeout = setTimeout(() => this.applyDynamicSizing(), DEBOUNCE_MS)
    }

    private applyDynamicSizing(): void {
        const cy = this.cy
        if (!cy) return

        const viewerStore = useViewerStore()
        const counts = viewerStore.proteinCountsAtTimepoint
        const maxCounts = viewerStore.maxProteinCounts
        const selectedSet = new Set(viewerStore.selectedGenes)

        if (Object.keys(counts).length === 0) return

        cy.startBatch()
        cy.nodes('.gene').forEach((node: any) => {
            const gene = node.id()

            // Only dynamically size selected genes; reset unselected to base
            if (selectedSet.size > 0 && !selectedSet.has(gene)) {
                node.removeStyle('padding')
                return
            }

            const value = counts[gene] ?? 0
            const maxValue = maxCounts[gene] ?? 1
            const normalised = maxValue > 0 ? Math.min(1, value / maxValue) : 0

            const p = COMPOUND_PADDING_RANGE.min +
                normalised * (COMPOUND_PADDING_RANGE.max - COMPOUND_PADDING_RANGE.min)
            node.style({ padding: `${p}px` })
        })
        cy.endBatch()
    }
}
