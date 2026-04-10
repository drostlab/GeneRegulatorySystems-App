/**
 * PanelGroup -- lightweight registry of related panels that share modifiers.
 *
 * Each group has an ID and manages a set of BasePanel instances.
 * Modifiers that need scoping accept a PanelGroup and only operate
 * on its visible surfaces, rather than iterating all subCharts.
 */
import type { SciChartSubSurface } from "scichart"
import type { BasePanel } from "../panels/BasePanel"


export class PanelGroup {
    readonly id: string
    private panels = new Map<string, BasePanel>()

    constructor(id: string) {
        this.id = id
    }

    /** Add a panel to this group. */
    add(panelId: string, panel: BasePanel): void {
        this.panels.set(panelId, panel)
    }

    /** Remove a panel from this group. */
    remove(panelId: string): void {
        this.panels.delete(panelId)
    }

    has(panelId: string): boolean {
        return this.panels.has(panelId)
    }

    get(panelId: string): BasePanel | undefined {
        return this.panels.get(panelId)
    }

    /** All panels in this group. */
    get allPanels(): BasePanel[] {
        return [...this.panels.values()]
    }

    /** IDs of all panels in this group. */
    get panelIds(): string[] {
        return [...this.panels.keys()]
    }

    /** Only the visible sub-surfaces in this group. */
    get visibleSurfaces(): SciChartSubSurface[] {
        return this.allPanels
            .filter(p => p.isVisible)
            .map(p => p.surface)
    }

    /** All sub-surfaces in this group (visible or not). */
    get allSurfaces(): SciChartSubSurface[] {
        return this.allPanels.map(p => p.surface)
    }

    get size(): number {
        return this.panels.size
    }

    /** Remove all panels. Does NOT dispose them. */
    clear(): void {
        this.panels.clear()
    }
}
