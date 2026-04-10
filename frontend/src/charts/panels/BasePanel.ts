import { ChartModifierBase2D, NumberRange, SciChartSubSurface, type SciChartSurface, type TSciChart } from "scichart";
import { getTheme, type ThemeMode } from "@/config/theme";

export const PATH_DIM_OPACITY = 0.1

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
    protected _highlightedPath: string | null = null
    /** Currently active gene filter (null = no filter). */
    protected _highlightedGene: string | null = null

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
        this.surface.applyTheme(getTheme(isDark).sciChartTheme)
        // Update explicitly-set grid line colours
        for (const axis of this.surface.yAxes.asArray()) {
            axis.majorGridLineStyle = { color: this.theme.chart.gridLine }
            axis.minorGridLineStyle = { color: this.theme.chart.gridLine }
        }
    }

    /**
     * Dim all series except those belonging to `path`. Pass null to restore.
     * Composes with gene filter via `_applyHighlightFilters()`.
     */
    highlightPath(path: string | null): void {
        this._highlightedPath = path
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

    /**
     * Determine whether a series matches ALL active highlight filters.
     * Returns true if the series should be shown at full opacity.
     */
    protected _seriesMatchesFilters(name: string): boolean {
        if (name.startsWith('__') || name.startsWith('segment:')) return true
        const colonIdx = name.indexOf(':')
        if (colonIdx < 0) return true
        if (this._highlightedPath !== null) {
            const seriesPath = name.substring(colonIdx + 1)
            if (seriesPath !== this._highlightedPath) return false
        }
        if (this._highlightedGene !== null) {
            const seriesGene = name.substring(0, colonIdx)
            if (seriesGene !== this._highlightedGene) return false
        }
        return true
    }

    /** Whether any highlight filter is currently active. */
    protected get _hasActiveFilter(): boolean {
        return this._highlightedPath !== null || this._highlightedGene !== null
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