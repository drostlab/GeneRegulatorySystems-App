import { ChartModifierBase2D, EChart2DModifierType, ECoordinateMode, EHorizontalAnchorPoint, EVerticalAnchorPoint, LineAnnotation, ModifierMouseArgs, TextAnnotation, Thickness, translateFromCanvasToSeriesViewRect, type ISciChartSubSurface } from "scichart"
import { getTheme } from "@/config/theme"
import type { PanelGroup } from "../layout/PanelGroup"
import { formatTime } from "../timeFormat"


export class SharedTimeCursorModifier extends ChartModifierBase2D {
    public type = EChart2DModifierType.Custom
    private xLines = new Map<string, LineAnnotation>()
    private activeLabel: { subChartId: string; annotation: TextAnnotation } | null = null
    private onTimeChanged?: (t: number) => void
    private isDark: boolean
    private group: PanelGroup

    constructor(group: PanelGroup, isDark: boolean, callback?: (t: number) => void) {
        super()
        this.group = group
        this.isDark = isDark
        this.onTimeChanged = callback
    }

    onAttachSubSurface(subChart: ISciChartSubSurface): void {
        if (!this._isInGroup(subChart)) return
        const t = getTheme(this.isDark)
        const line = new LineAnnotation({
            xCoordinateMode: ECoordinateMode.DataValue,
            yCoordinateMode: ECoordinateMode.Relative,
            stroke: t.chart.cursor,
            strokeThickness: 3,
            isHidden: true
        })
        subChart.annotations.add(line)
        this.xLines.set(subChart.id, line)
    }

    onDetachSubSurface(subChart: ISciChartSubSurface): void {
        const line = this.xLines.get(subChart.id)
        if (line) {
            subChart.annotations.remove(line)
            line.delete()
            this.xLines.delete(subChart.id)
        }
        // If the active label is on this chart, delete it
        if (this.activeLabel?.subChartId === subChart.id) {
            this._deleteLabel()
        }
    }

    modifierMouseMove(args: ModifierMouseArgs): void {
        super.modifierMouseMove(args)
        const time = this._timeFromMouse()
        if (time !== undefined) {
            this._showCursorAt(time)
            this.onTimeChanged?.(time)
        }
    }

    modifierMouseLeave(_: ModifierMouseArgs): void {
        // Cursor stays visible at last position
    }

    /** Programmatically move the cursor to a given time value. */
    setCursorTime(time: number): void {
        this._showCursorAt(time)
    }

    /** Re-apply theme colours to cursor lines and label. */
    applyColorTheme(isDark: boolean): void {
        this.isDark = isDark
        const t = getTheme(isDark)
        for (const line of this.xLines.values()) {
            line.stroke = t.chart.cursor
        }
        if (this.activeLabel) {
            this.activeLabel.annotation.textColor = t.chart.cursorText
            this.activeLabel.annotation.background = t.chart.cursor
        }
    }

    /** Called when subchart visibility changes, to move the label to the new bottom chart. */
    onSubChartVisibilityChanged(): void {
        this._showCursorAt(this._lastTime)
    }

    /** Hide all cursor lines and labels. */
    hideCursor(): void {
        for (const line of this.xLines.values()) line.isHidden = true
        this._deleteLabel()
    }

    /**
     * Re-order cursor lines to the end of each subchart's annotation collection
     * so they render above all data annotations.
     * Call this after new annotations are added (e.g. after setScheduleData).
     */
    bringToFront(): void {
        for (const sc of this.group.allSurfaces) {
            const line = this.xLines.get(sc.id)
            if (!line) continue
            sc.annotations.remove(line)
            sc.annotations.add(line)
        }
    }

    // ---- internals ----

    private _lastTime = 0

    /** Resolve the data-space time from the current mouse position. */
    private _timeFromMouse(): number | undefined {
        if (!this.mousePoint) return undefined

        for (const sc of this.group.allSurfaces) {
            const pt = translateFromCanvasToSeriesViewRect(this.mousePoint, sc.seriesViewRect)
            if (pt) {
                const calc = sc.xAxes.get(0).getCurrentCoordinateCalculator()
                return calc.getDataValue(pt.x)
            }
        }
        return undefined
    }

    /** Show cursor lines on all visible subcharts and the label on the bottom-most one. */
    private _showCursorAt(time: number): void {
        this._lastTime = time
        const lastVisibleId = this._lastVisibleSubChartId()
        const lastVisibleChart = lastVisibleId
            ? this.group.allSurfaces.find(sc => sc.id === lastVisibleId)
            : null

        // Show/update lines on all visible subcharts in the group
        for (const sc of this.group.allSurfaces) {
            const line = this.xLines.get(sc.id)
            if (!line) continue

            if (!sc.isVisible) {
                line.isHidden = true
            } else {
                line.isHidden = false
                line.x1 = time
                line.x2 = time
                line.y1 = -1.0
                line.y2 = 2.0
            }
            if (sc.id === lastVisibleId)
                line.y2 = 1.0
        }

        // Create or update label only on the last visible chart
        if (lastVisibleChart && lastVisibleChart.isVisible) {
            if (this.activeLabel?.subChartId !== lastVisibleId) {
                // Label needs to move to a different chart
                this._deleteLabel()
                this._createLabelOn(lastVisibleChart, time)
            } else if (this.activeLabel) {
                // Update existing label
                this.activeLabel.annotation.x1 = time
                this.activeLabel.annotation.text = formatTime(time)
            }
        } else {
            // No visible chart, delete label if it exists
            this._deleteLabel()
        }
    }

    /** Create a new label on the given subchart. */
    private _createLabelOn(subChart: ISciChartSubSurface, time: number): void {
        const t = getTheme(this.isDark)
        const label = new TextAnnotation({
            xCoordinateMode: ECoordinateMode.DataValue,
            yCoordinateMode: ECoordinateMode.Relative,
            x1: time,
            y1: 1,
            verticalAnchorPoint: EVerticalAnchorPoint.Bottom,
            horizontalAnchorPoint: EHorizontalAnchorPoint.Center,
            fontSize: 8,
            textColor: t.chart.cursorText,
            background: t.chart.cursor,
            opacity: 1.0,
            padding: new Thickness(3, 2, 3, 2),
            text: formatTime(time)
        })
        subChart.annotations.add(label)
        this.activeLabel = { subChartId: subChart.id, annotation: label }
    }

    /** Delete the active label. */
    private _deleteLabel(): void {
        if (this.activeLabel) {
            const subChart = this.group.allSurfaces.find(sc => sc.id === this.activeLabel!.subChartId)
            if (subChart) {
                subChart.annotations.remove(this.activeLabel.annotation)
                this.activeLabel.annotation.delete()
            }
            this.activeLabel = null
        }
    }

    /** Return the id of the last visible subchart in this group (bottom-most). */
    private _lastVisibleSubChartId(): string | undefined {
        const surfaces = this.group.visibleSurfaces
        return surfaces.length > 0 ? surfaces[surfaces.length - 1]!.id : undefined
    }

    private _isInGroup(subChart: ISciChartSubSurface): boolean {
        return this.group.allSurfaces.some(s => s.id === subChart.id)
    }
}