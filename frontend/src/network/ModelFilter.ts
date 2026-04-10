/**
 * Model filtering module.
 *
 * Watches viewerStore.activeModelPath and hides/shows nodes+edges
 * based on the union network's model_exclusions.
 *
 * Uses CSS class toggling (`.excluded { display: none }`) instead of
 * element removal, avoiding conflicts with AdaptiveZoom's add/remove.
 */
import type { Core } from 'cytoscape'
import { watch, type WatchStopHandle } from 'vue'
import { useViewerStore } from '@/stores/viewerStore'
import { useScheduleStore } from '@/stores/scheduleStore'

export class ModelFilter {
    private cy: Core | null = null
    private stopWatch: WatchStopHandle | null = null
    private excludedNodes = new Set<string>()
    private excludedLinks = new Set<string>()

    attach(cy: Core): void {
        this.cy = cy

        this.stopWatch = watch(
            () => useViewerStore().activeModelPath,
            () => this.updateExclusions(),
            { immediate: true },
        )
    }

    destroy(): void {
        this.stopWatch?.()
        this.stopWatch = null
        this.excludedNodes.clear()
        this.excludedLinks.clear()
        this.cy = null
    }

    /** Re-apply current exclusions to all in-graph elements. Call after elements are added externally. */
    refresh(): void {
        this.applyExclusions()
    }

    private updateExclusions(): void {
        const viewerStore = useViewerStore()
        const scheduleStore = useScheduleStore()
        const union = scheduleStore.unionNetwork
        if (!union) return

        const modelPath = viewerStore.activeModelPath
        if (!modelPath) {
            this.excludedNodes.clear()
            this.excludedLinks.clear()
            this.applyExclusions()
            return
        }

        const exclusions = union.model_exclusions[modelPath]
        this.excludedNodes = new Set(exclusions?.nodes ?? [])
        this.excludedLinks = new Set(exclusions?.links ?? [])

        this.applyExclusions()
    }

    private applyExclusions(): void {
        const cy = this.cy
        if (!cy) return

        cy.startBatch()

        cy.nodes().forEach((node: any) => {
            node.toggleClass('excluded', this.excludedNodes.has(node.id()))
        })

        cy.edges().forEach((edge: any) => {
            const originals: string[] = edge.data('originalLinkIds') ?? []
            const allExcluded = originals.length > 0
                && originals.every((id: string) => this.excludedLinks.has(id))
            edge.toggleClass('excluded', allExcluded)
        })

        cy.endBatch()
    }
}
