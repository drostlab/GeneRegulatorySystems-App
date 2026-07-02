import { BoxAnnotation, ChartModifierBase2D, ECoordinateMode, NumberRange, SciChartSubSurface, type SciChartSurface, type TSciChart } from "scichart";
import { getTheme, PURPLE, type ThemeMode } from "@/config/theme";

export const PATH_DIM_OPACITY = 0.05

export interface BasePanelOptions {
    parentSurface: SciChartSurface
    wasmContext: TSciChart
    isDark: boolean
    modifiers?: Array<{
        modifierClass: new (args?: any) => ChartModifierBase2D
        args?: any
    }>
}

export abstract class BasePanel {
    surface: SciChartSubSurface
    wasmContext: TSciChart
    parentSurface: SciChartSurface
    protected theme: ThemeMode

    /** Currently active path filter (null = no filter). */
    protected _highlightedPaths: ReadonlySet<string> | null = null
    /** Currently active gene filter (null = no filter). */
    protected _highlightedGene: string | null = null
    private scheduleBrush: BoxAnnotation | null = null

    constructor({parentSurface, wasmContext, isDark, modifiers = []}: BasePanelOptions) {
        this.parentSurface = parentSurface
        this.wasmContext = wasmContext
        this.theme = getTheme(isDark)
        this.surface = SciChartSubSurface.createSubSurface(parentSurface, {theme: getTheme(isDark).sciChartTheme})

        modifiers.forEach(({modifierClass: ModifierClass, args}) => {
            this.surface.chartModifiers.add(new ModifierClass(args))
        })
    }

    get isVisible() {
        return this.surface.isVisible
    }

    set isVisible(value: boolean) {
        this.surface.isVisible = value
    }

    setTimeExtent(minTime: number, maxTime: number): void {
        const xAxis = this.surface.xAxes.get(0)
        if (xAxis) {
            xAxis.visibleRange = new NumberRange(minTime, maxTime)
            xAxis.visibleRangeLimit = new NumberRange(minTime, maxTime)
        }
    }

    /** Update visible range without changing the limit (for streaming). */
    setVisibleTimeRange(minTime: number, maxTime: number): void {
        const xAxis = this.surface.xAxes.get(0)
        if (xAxis) {
            xAxis.visibleRange = new NumberRange(minTime, maxTime)
        }
    }

    clearData(): void {
        this.surface.renderableSeries.asArray().forEach(rs => {
            rs.dataSeries?.delete()
        })
        this.surface.renderableSeries.clear()
        // Note: annotations are NOT cleared here -- modifiers manage their own annotations
    }

    /** Re-apply theme colours after a dark-mode toggle. */
    applyTheme(isDark: boolean): void {
        this.theme = getTheme(isDark)
        this.surface.applyTheme(this.theme.sciChartTheme)
        // Update explicitly-set grid line colours
        for (const axis of this.surface.yAxes.asArray()) {
            axis.majorGridLineStyle = { color: this.theme.chart.gridLine }
            axis.minorGridLineStyle = { color: this.theme.chart.gridLine }
        }
        this.surface.invalidateElement()
    }

    /**
     * Dim all series except those belonging to `path`. Pass null to restore.
     * Composes with gene filter via `_applyHighlightFilters()`.
     */
    highlightPath(paths: ReadonlySet<string> | string | null): void {
        this._highlightedPaths = paths === null
            ? null
            : typeof paths === 'string'
                ? new Set([paths])
                : typeof paths.has === 'function'
                    ? paths
                    : new Set(paths as Iterable<string>)
        this._applyHighlightFilters()
    }

    /**
     * Dim all series except those belonging to `gene`. Pass null to restore.
     * Composes with path filter via `_applyHighlightFilters()`.
     */
    highlightGene(gene: string | null): void {
        this._highlightedGene = gene
        this._applyHighlightFilters()
    }

    /** Show the schedule glyph's time occupancy on this panel's own x-axis. */
    setScheduleBrush(range: { from: number; to: number } | null): void {
        if (this.scheduleBrush) {
            this.surface.annotations.remove(this.scheduleBrush)
            this.scheduleBrush.delete()
            this.scheduleBrush = null
        }
        if (!range) return
        const to = range.to > range.from ? range.to : range.from + Number.EPSILON
        this.scheduleBrush = new BoxAnnotation({
            x1: range.from,
            x2: to,
            y1: 0,
            y2: 1,
            xCoordinateMode: ECoordinateMode.DataValue,
            yCoordinateMode: ECoordinateMode.Relative,
            fill: PURPLE[400],
            opacity: 0.14,
            strokeThickness: 0,
            isEditable: false,
        })
        this.surface.annotations.add(this.scheduleBrush)
    }

    /**
     * Determine whether a series matches ALL active highlight filters.
     * Returns true if the series should be shown at full opacity.
     */
    protected _seriesMatchesFilters(name: string): boolean {
        if (name.startsWith('__') || name.startsWith('segment:')) return true
        const colonIdx = name.indexOf(':')
        if (colonIdx < 0) return true
        if (this._highlightedPaths !== null) {
            const seriesPath = name.substring(colonIdx + 1)
            if (!this._highlightedPaths.has(seriesPath)) return false
        }
        if (this._highlightedGene !== null) {
            const seriesGene = name.substring(0, colonIdx)
            if (seriesGene !== this._highlightedGene) return false
        }
        return true
    }

    /** Whether any highlight filter is currently active. */
    protected get _hasActiveFilter(): boolean {
        return this._highlightedPaths !== null || this._highlightedGene !== null
    }

    /**
     * Apply composable highlight filters (path + gene) to all series.
     * Series are identified by `<gene>:<path>` in dataSeriesName.
     * Skips internal series (prefixed `__`) and segment rectangles.
     */
    protected _applyHighlightFilters(): void {
        for (const rs of this.surface.renderableSeries.asArray()) {
            const name = rs.dataSeries?.dataSeriesName ?? ''
            if (name.startsWith('__') || name.startsWith('segment:')) continue
            const colonIdx = name.indexOf(':')
            if (colonIdx < 0) continue
            rs.opacity = this._seriesMatchesFilters(name) ? 1 : PATH_DIM_OPACITY
        }
    }

    dispose(): void {
        this.clearData()
        // Sub-surface deletion is handled by the parent SciChartSurface.delete() cascade;
        // calling delete() here as well causes a double-deletion warning from SciChart.
    }
}
