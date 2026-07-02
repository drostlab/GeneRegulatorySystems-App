import { EAxisAlignment, ELineDrawMode, ENumericFormat, FastLineRenderableSeries, LogarithmicAxis, NumberRange, NumericAxis, SweepAnimation, XyDataSeries } from "scichart"
import type { AxisBase2D } from "scichart"
import { TimeseriesPanel } from "./TimeseriesPanel"
import type { BasePanelOptions } from "./BasePanel"
import type { TimeseriesData } from "@/types/simulation"
import { getGeneFromSpeciesName } from "@/types/schedule"
import { CHART_FONT_SIZES, AXIS_THICKNESS_NARROW } from "../chartConstants"
import { setupTimeAxis } from "../timeFormat"

const SWEEP_DURATION_MS = 400


export class CountsPanel extends TimeseriesPanel {
    /** Persistent data series map for streaming: `label:path` -> XyDataSeries */
    private seriesMap: Map<string, XyDataSeries> = new Map()

    private readonly title: string
    private logScale = false

    constructor(options: BasePanelOptions, title: string) {
        super(options)
        this.title = title

        const xAxis = new NumericAxis(this.wasmContext, {
            axisTitle: "Time",
            labelStyle: {fontSize: CHART_FONT_SIZES.label},
            axisTitleStyle: {fontSize: CHART_FONT_SIZES.title},
            drawMajorBands: false,
            drawMajorGridLines: false,
            drawMinorGridLines: false
        })
        setupTimeAxis(xAxis)

        this.surface.xAxes.add(xAxis)
        this.surface.yAxes.add(this.buildYAxis())
    }

    /** Build the count (y) axis: logarithmic when `logScale` is set, else linear. */
    private buildYAxis(): AxisBase2D {
        const common = {
            axisTitle: this.title,
            axisAlignment: EAxisAlignment.Left,
            labelStyle: {fontSize: CHART_FONT_SIZES.label},
            axisTitleStyle: {fontSize: CHART_FONT_SIZES.title},
            drawMajorBands: false,
            drawMajorTickLines: false,
            drawMinorTickLines: false,
            growBy: new NumberRange(0.01, 0.01),
            majorGridLineStyle: { color: this.theme.chart.gridLine},
            minorGridLineStyle: { color: this.theme.chart.gridLine},
            axisThickness: AXIS_THICKNESS_NARROW
        }
        return this.logScale
            ? new LogarithmicAxis(this.wasmContext, {
                ...common,
                logarithmicBase: 10,
                labelFormat: ENumericFormat.Decimal,
                // Counts of 0 can't be represented on a log axis; floor the
                // visible range at 1 so the axis doesn't collapse toward zero.
                visibleRangeLimit: new NumberRange(1, Number.MAX_SAFE_INTEGER),
            })
            : new NumericAxis(this.wasmContext, {
                ...common,
                labelFormat: ENumericFormat.Decimal,
                labelPrecision: 0,
            })
    }

    /** Toggle logarithmic scaling on the count (y) axis. */
    setLogScale(enabled: boolean): void {
        if (enabled === this.logScale) return
        this.logScale = enabled
        const old = this.surface.yAxes.get(0)
        this.surface.yAxes.remove(old)
        old.delete()
        this.surface.yAxes.add(this.buildYAxis())
        this.surface.zoomExtentsY()
    }

    override clearData(): void {
        this.seriesMap.clear()
        super.clearData()
    }

    setData(timeseries: TimeseriesData, { animate = true }: { animate?: boolean } = {}): void {
        if (!timeseries) {
            this.clearData()
            return
        }
        if (!this.metadata) {
            console.warn("[CountsPanel] trying to add timeseries when no metadata is available")
            return
        }

        // Build set of keys that should exist after this call
        const incomingKeys = new Set<string>()
        for (const [species, pathData] of Object.entries(timeseries)) {
            for (const path of Object.keys(pathData)) {
                const label = getGeneFromSpeciesName(species) ?? species
                incomingKeys.add(`${label}:${path}`)
            }
        }

        // Remove stale series (keys no longer present)
        for (const key of [...this.seriesMap.keys()]) {
            if (!incomingKeys.has(key)) {
                this._removeRenderableSeries(key)
            }
        }

        // Add or update series
        this.surface.suspendUpdates()
        for (const [species, pathData] of Object.entries(timeseries)) {
            for (const [path, series] of Object.entries(pathData)) {
                const label = getGeneFromSpeciesName(species) ?? species
                const key = `${label}:${path}`
                const time = series.map(pair => pair[0])
                // -1 is the gap marker inserted between non-contiguous episodes
                const counts = series.map(pair => pair[1] === -1 ? NaN : pair[1])

                const existing = this.seriesMap.get(key)
                if (existing) {
                    // Update data in place (no animation)
                    existing.clear()
                    existing.appendRange(time, counts)
                } else {
                    // New series: create with sweep animation
                    const colour = this.metadata.gene_colours[label] ?? this.theme.chart.fallbackSeries
                    const xySeries = new XyDataSeries(this.wasmContext, {
                        isSorted: true,
                        containsNaN: true,
                        dataSeriesName: key
                    })
                    xySeries.appendRange(time, counts)
                    this.seriesMap.set(key, xySeries)

                    const lineSeries = new FastLineRenderableSeries(this.wasmContext, {
                        dataSeries: xySeries,
                        stroke: colour,
                        strokeThickness: 1,
                        isDigitalLine: true,
                        drawNaNAs: ELineDrawMode.DiscontinuousLine,
                        animation: animate ? new SweepAnimation({ duration: SWEEP_DURATION_MS }) : undefined
                    })
                    this.surface.renderableSeries.add(lineSeries)
                }
            }
        }
        this.surface.resumeUpdates()
    }

    /** Remove a renderable series (and its data series) by key. */
    private _removeRenderableSeries(key: string): void {
        const dataSeries = this.seriesMap.get(key)
        if (!dataSeries) return
        const renderables = this.surface.renderableSeries.asArray()
        const rs = renderables.find(r => r.dataSeries === dataSeries)
        if (rs) {
            this.surface.renderableSeries.remove(rs)
            rs.delete()
        }
        dataSeries.delete()
        this.seriesMap.delete(key)
    }
}
