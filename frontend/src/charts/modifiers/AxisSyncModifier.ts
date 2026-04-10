import { AxisBase2D, ChartModifierBase2D, EChart2DModifierType, type ISciChartSubSurface } from "scichart"
import type { PanelGroup } from "../layout/PanelGroup"


/**
 * Synchronises x-axis visible ranges across sub-surfaces
 * belonging to a specific PanelGroup (not all subCharts).
 */
export class AxisSyncModifier extends ChartModifierBase2D {
    public type = EChart2DModifierType.Custom
    private group: PanelGroup

    constructor(group: PanelGroup) {
        super()
        this.group = group
    }

    onAttachSubSurface(subChart: ISciChartSubSurface): void {
        // Only attach to surfaces in our group
        if (!this._isInGroup(subChart)) return
        subChart.xAxes.asArray().forEach(xAxis => this._attachAxis(xAxis))
    }

    private _attachAxis(xAxis: AxisBase2D): void {
        xAxis.visibleRangeChanged.subscribe(args => {
            if (!args?.visibleRange) return
            const { visibleRange } = args
            for (const sc of this.group.allSurfaces) {
                for (const ax of sc.xAxes.asArray()) {
                    if (ax !== xAxis) {
                        const vr = ax.visibleRange
                        if (!vr || vr.min !== visibleRange.min || vr.max !== visibleRange.max) {
                            ax.visibleRange = visibleRange
                        }
                    }
                }
            }
        })
    }

    private _isInGroup(subChart: ISciChartSubSurface): boolean {
        return this.group.allSurfaces.some(s => s.id === subChart.id)
    }
}