import { EAxisAlignment, ELineDrawMode, ENumericFormat, FastLineRenderableSeries, NumberRange, NumericAxis, SweepAnimation, XyDataSeries } from "scichart"
import { TimeseriesPanel } from "./TimeseriesPanel"
import type { BasePanelOptions } from "./BasePanel"
import type { TimeseriesData } from "@/types/simulation"
import { getGeneFromSpeciesName } from "@/types/schedule"
import { CHART_FONT_SIZES, AXIS_THICKNESS_NARROW } from "../chartConstants"
import { setupTimeAxis } from "../timeFormat"

const SWEEP_DURATION_MS = 400


export class CountsPanel extends TimeseriesPanel {
    /** Persistent data series map for streaming: `geneId:path` -> XyDataSeries */
    private seriesMap: Map<string, XyDataSeries> = new Map()

    constructor(options: BasePanelOptions, title: string) {
        super(options)

        const xAxis = new NumericAxis(this.wasmContext, {
            axisTitle: "Time",
            labelStyle: {fontSize: CHART_FONT_SIZES.label},
            axisTitleStyle: {fontSize: CHART_FONT_SIZES.title},
            drawMajorBands: false,
            drawMajorGridLines: false,
            drawMinorGridLines: false
        })
        setupTimeAxis(xAxis)

        const yAxis = new NumericAxis(this.wasmContext, {
            axisTitle: title,
            axisAlignment: EAxisAlignment.Left,
            labelFormat: ENumericFormat.Decimal,
            labelPrecision: 0,
            labelStyle: {fontSize: CHART_FONT_SIZES.label},
            axisTitleStyle: {fontSize: CHART_FONT_SIZES.title},
            drawMajorBands: false,
            drawMajorTickLines: false,
            drawMinorTickLines: false,
            growBy: new NumberRange(0.01, 0.01),
            majorGridLineStyle: { color: this.theme.chart.gridLine},
            minorGridLineStyle: { color: this.theme.chart.gridLine},
            axisThickness: AXIS_THICKNESS_NARROW
        })

        this.surface.xAxes.add(xAxis)
        this.surface.yAxes.add(yAxis)
    }

    override clearData(): void {
        this.seriesMap.clear()
        super.clearData()
    }

    setData(timeseries: TimeseriesData): void {
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
                const geneId = getGeneFromSpeciesName(species) ?? ""
                incomingKeys.add(`${geneId}:${path}`)
            }
        }

        // Remove stale series (keys no longer present)
        for (const key of [...this.seriesMap.keys()]) {
            if (!incomingKeys.has(key)) {
                this._removeRenderableSeries(key)
            }
        }

        // Add or update series
        let created = 0
        for (const [species, pathData] of Object.entries(timeseries)) {
            for (const [path, series] of Object.entries(pathData)) {
                const geneId = getGeneFromSpeciesName(species) ?? ""
                const key = `${geneId}:${path}`
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
                    const colour = this.metadata.gene_colours[geneId] ?? this.theme.chart.fallbackSeries
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
                        animation: new SweepAnimation({ duration: SWEEP_DURATION_MS })
                    })
                    this.surface.renderableSeries.add(lineSeries)
                    created++
                }
            }
        }
    }

    appendStreamingData(timeseries: TimeseriesData): void {
        if (!this.metadata) return

        this.surface.suspendUpdates()
        for (const [species, pathData] of Object.entries(timeseries)) {
            for (const [path, points] of Object.entries(pathData)) {
                const geneId = getGeneFromSpeciesName(species) ?? ""
                const key = `${geneId}:${path}`

                let xySeries = this.seriesMap.get(key)
                if (!xySeries) {
                    xySeries = this._createStreamingSeries(key, geneId)
                }

                const time: number[] = []
                const counts: number[] = []
                for (let i = 0; i < points.length; i++) {
                    time.push(points[i]![0])
                    // -1 is the gap marker between non-contiguous episodes
                    counts.push(points[i]![1] === -1 ? NaN : points[i]![1])
                }
                xySeries.appendRange(time, counts)
            }
        }
        this.surface.resumeUpdates()
    }

    /** Create a new XyDataSeries + FastLineRenderableSeries for a streaming key. */
    private _createStreamingSeries(key: string, geneId: string): XyDataSeries {
        const colour = this.metadata!.gene_colours[geneId] ?? this.theme.chart.fallbackSeries
        const xySeries = new XyDataSeries(this.wasmContext, {
            isSorted: true,
            containsNaN: true,
            dataSeriesName: key
        })
        this.seriesMap.set(key, xySeries)

        const lineSeries = new FastLineRenderableSeries(this.wasmContext, {
            dataSeries: xySeries,
            stroke: colour,
            strokeThickness: 1,
            isDigitalLine: true,
            drawNaNAs: ELineDrawMode.DiscontinuousLine
        })
        this.surface.renderableSeries.add(lineSeries)
        return xySeries
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
