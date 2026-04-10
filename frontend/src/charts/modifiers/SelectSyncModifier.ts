import { ChartModifierBase2D, EChart2DModifierType, ModifierMouseArgs, translateFromCanvasToSeriesViewRect, type IRenderableSeries } from "scichart"
import type { PanelGroup } from "../layout/PanelGroup"
import { hitTestNearest } from "./hitTestUtils"

/** Function that maps a dataSeriesName to a group key, or null to exclude. */
export type GroupingFn = (dataSeriesName: string) => string | null

/**
 * Synchronises series selection across all sub-surfaces in a PanelGroup.
 *
 * Click = solo (select only the clicked gene, or deselect if already the sole selection).
 * Ctrl/Cmd+Click = toggle (add/remove from current selection).
 */
export class SelectSyncModifier extends ChartModifierBase2D {
    public type = EChart2DModifierType.Custom
    private selectedGroups: Set<string> = new Set()
    private onSelectionChange?: (selectedGroups: string[]) => void
    private groupFn: GroupingFn
    private group: PanelGroup

    constructor(group: PanelGroup, groupFn: GroupingFn, callback?: (selectedGroups: string[]) => void) {
        super()
        this.group = group
        this.groupFn = groupFn
        this.onSelectionChange = callback
    }

    modifierMouseUp(args: ModifierMouseArgs): void {
        super.modifierMouseUp(args)
        if (!this.mousePoint) return

        const clickedGroup = this.findClickedGroup()
        if (!clickedGroup) return

        const isToggle = args.ctrlKey || args.nativeEvent?.metaKey === true
        const newSelection = new Set(this.selectedGroups)

        if (isToggle) {
            if (newSelection.has(clickedGroup)) {
                newSelection.delete(clickedGroup)
            } else {
                newSelection.add(clickedGroup)
            }
        } else {
            // Solo: select only the clicked gene, or deselect if it was the sole selection
            if (newSelection.size === 1 && newSelection.has(clickedGroup)) {
                newSelection.clear()
            } else {
                newSelection.clear()
                newSelection.add(clickedGroup)
            }
        }

        const selectionChanged =
            newSelection.size !== this.selectedGroups.size ||
            [...newSelection].some(g => !this.selectedGroups.has(g))

        if (selectionChanged) {
            this.selectedGroups = newSelection
            this.syncSelectionState(newSelection)
            console.debug(`[SelectSync] Selection changed (${isToggle ? 'toggle' : 'solo'}): [${[...newSelection]}]`)
            this.onSelectionChange?.([...newSelection])
        } else {
            // SeriesSelectionModifier may have toggled isSelected flags -- force back to our state
            this.syncSelectionState(this.selectedGroups)
        }
    }

    /** Identify the gene group under the click point. */
    private findClickedGroup(): string | null {
        if (!this.mousePoint) return null
        for (const sc of this.group.allSurfaces) {
            const pt = translateFromCanvasToSeriesViewRect(this.mousePoint, sc.seriesViewRect)
            if (!pt) continue

            const selectableSeries = sc.renderableSeries
                .asArray()
                .filter(series => this.resolveGroup(series) !== null)
            if (selectableSeries.length === 0) continue

            const nearest = hitTestNearest(selectableSeries, pt)
            if (!nearest) continue

            const group = this.resolveGroup(nearest.series)
            if (group) return group
        }
        return null
    }

    private syncSelectionState(selectedGroups: Set<string>): void {
        for (const subChart of this.group.allSurfaces) {
            for (const series of subChart.renderableSeries.asArray()) {
                const group = this.resolveGroup(series)
                if (!group) continue
                series.isSelected = selectedGroups.has(group)
            }
        }
    }

    public clearSelection(): void {
        this.syncSelectionState(new Set())
        this.selectedGroups.clear()
        this.onSelectionChange?.([])
    }

    /** Re-apply current selection state to all series (call after series are recreated). */
    public reapplySelection(): void {
        if (this.selectedGroups.size === 0) return
        console.debug(`[SelectSync] Reapplying selection: [${[...this.selectedGroups]}]`)
        this.syncSelectionState(this.selectedGroups)
    }

    private resolveGroup(series: IRenderableSeries): string | null {
        const name = series.dataSeries?.dataSeriesName
        return name ? this.groupFn(name) : null
    }
}
