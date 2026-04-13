import { EAxisAlignment, ELineDrawMode, EResamplingMode, FastBandRenderableSeries, NumericAxis, SweepAnimation, XyyDataSeries } from "scichart"
import { TimeseriesPanel } from "./TimeseriesPanel"
import { PATH_DIM_OPACITY, type BasePanelOptions } from "./BasePanel"
import type { TimeseriesData, TimeseriesMetadata } from "@/types/simulation"
import { restructureTimeseriesByPathAndGene } from "@/types/simulation"
import { getGeneFromSpeciesName } from "@/types/schedule"
import { CHART_FONT_SIZES, AXIS_THICKNESS } from "../chartConstants"
import { withOpacity } from "@/utils/colorUtils"
import { setupTimeAxis } from "../timeFormat"

const SWEEP_DURATION_MS = 400

export type PathYRanges = Map<string, { yMin: number; yMax: number }>

export class PromoterPanel extends TimeseriesPanel {
    private pathYRanges: PathYRanges = new Map()

    /** Persistent data series map for streaming: `label:path` -> XyyDataSeries */
    private seriesMap: Map<string, XyyDataSeries> = new Map()

    /** Cached band layout params per series key: { yCenter, bandHeight } */
    private bandParams: Map<string, { yCenter: number; bandHeight: number }> = new Map()

    /** Original hex colour per series key — used by highlightPath to dim fills. */
    private keyColourMap: Map<string, string> = new Map()

    constructor(options: BasePanelOptions) {
        super(options)

        const xAxis = new NumericAxis(this.wasmContext, {
            axisTitle: "Time",
            labelStyle: { fontSize: CHART_FONT_SIZES.label },
            axisTitleStyle: { fontSize: CHART_FONT_SIZES.title},
            drawMajorBands: false,
            drawMajorGridLines: false,
            drawMinorGridLines: false
        })
        setupTimeAxis(xAxis)

        const yAxis = new NumericAxis(this.wasmContext, {
            axisTitle: "Promoter Activity",
            axisAlignment: EAxisAlignment.Left,
            axisTitleStyle: { fontSize: CHART_FONT_SIZES.title},
            drawMajorBands: false,
            drawMajorGridLines: false,
            drawMinorGridLines: false,
            drawMajorTickLines: false,
            drawMinorTickLines: false,
            drawLabels: false,
            axisThickness: AXIS_THICKNESS
        })

        this.surface.xAxes.add(xAxis)
        this.surface.yAxes.add(yAxis)
    }

    setPathYRanges(ranges: PathYRanges): void {
        this.pathYRanges = ranges
        this._precomputeBandParams()
    }

    override setMetadata(metadata: TimeseriesMetadata | null): void {
        super.setMetadata(metadata)
        this._precomputeBandParams()
    }

    /**
     * Pre-compute yCenter and bandHeight for every (gene, path) combination
     * so streaming can use correct layout without needing all data up front.
     */
    private _precomputeBandParams(): void {
        this.bandParams.clear()
        if (!this.metadata || this.pathYRanges.size === 0) return

        const scheduleGenes = [...this.metadata.genes]
        const genesCount = scheduleGenes.length
        if (genesCount === 0) return

        for (const [path, yRange] of this.pathYRanges) {
            const bandHeight = (yRange.yMax - yRange.yMin) / genesCount
            scheduleGenes.forEach((geneId, geneIndex) => {
                const key = `${geneId}:${path}`
                const yCenter = yRange.yMax - geneIndex * bandHeight - 0.5 * bandHeight
                this.bandParams.set(key, { yCenter, bandHeight })
            })
        }
    }

    override clearData(): void {
        this.seriesMap.clear()
        // Note: bandParams is NOT cleared here -- it's layout, recomputed from setMetadata/setPathYRanges
        super.clearData()
    }

    setData(timeseries: TimeseriesData): void {
        if (!timeseries || !this.metadata) {
            this.clearData()
            return
        }

        const dataByPath = restructureTimeseriesByPathAndGene(timeseries, this.metadata)

        // Build set of keys that should exist and compute new band params
        const incomingKeys = new Set<string>()
        const scheduleGenes = this.metadata?.genes ?? []
        for (const [path, geneData] of Object.entries(dataByPath)) {
            const yRange = this.pathYRanges.get(path)
            if (!yRange) continue
            const pathGenes = scheduleGenes.filter(g => g in geneData)
            const genesCount = pathGenes.length
            const bandHeight = (yRange.yMax - yRange.yMin) / genesCount
            pathGenes.forEach((geneId, geneIndex) => {
                const key = `${geneId}:${path}`
                const yCenter = yRange.yMax - geneIndex * bandHeight - 0.5 * bandHeight
                this.bandParams.set(key, { yCenter, bandHeight })
                incomingKeys.add(key)
            })
        }

        // Remove stale series
        for (const key of [...this.seriesMap.keys()]) {
            if (!incomingKeys.has(key)) {
                this._removeRenderableSeries(key)
            }
        }

        // Add or update series
        let created = 0
        for (const [path, geneData] of Object.entries(dataByPath)) {
            const yRange = this.pathYRanges.get(path)
            if (!yRange) continue

            const pathGenes = scheduleGenes.filter(g => g in geneData)
            pathGenes.forEach((geneId) => {
                const { colour, series } = geneData[geneId]!
                const key = `${geneId}:${path}`
                const { yCenter, bandHeight } = this.bandParams.get(key)!
                const { xData, yTop, yBottom } = this._buildBandArrays(series, yCenter, bandHeight)

                const existing = this.seriesMap.get(key)
                if (existing) {
                    // Update data in place (repositions bands, no animation)
                    existing.clear()
                    if (xData.length > 0) {
                        existing.appendRange(xData, yTop, yBottom)
                    }
                } else {
                    // New series: create with sweep animation
                    const xyyDataSeries = new XyyDataSeries(this.wasmContext, {
                        isSorted: true,
                        containsNaN: true,
                        dataSeriesName: key
                    })
                    if (xData.length > 0) {
                        xyyDataSeries.appendRange(xData, yTop, yBottom)
                    }
                    this.seriesMap.set(key, xyyDataSeries)

                    this.keyColourMap.set(key, colour)
                    const bandSeries = new FastBandRenderableSeries(this.wasmContext, {
                        dataSeries: xyyDataSeries,
                        stroke: colour,
                        strokeThickness: 0.0,
                        fillY1: colour,
                        strokeY1: colour,
                        drawNaNAs: ELineDrawMode.DiscontinuousLine,
                        resamplingMode: EResamplingMode.None,
                        animation: new SweepAnimation({ duration: SWEEP_DURATION_MS })
                    })
                    this.surface.renderableSeries.add(bandSeries)
                    created++
                }
            })
        }
    }

    appendStreamingData(timeseries: TimeseriesData): void {
        if (!this.metadata) return

        this.surface.suspendUpdates()
        for (const [species, pathData] of Object.entries(timeseries)) {
            for (const [path, points] of Object.entries(pathData)) {
                const label = getGeneFromSpeciesName(species) ?? species
                const key = `${label}:${path}`

                const params = this.bandParams.get(key)
                if (!params) {
                    continue
                }

                const isNew = !this.seriesMap.has(key)
                let xyyData = this.seriesMap.get(key)
                if (!xyyData) {
                    xyyData = this._createStreamingSeries(key, label)
                }

                const { yCenter, bandHeight } = params
                const { xData, yTop, yBottom } = this._buildBandArrays(points, yCenter, bandHeight)
                const tFirst = xData[0]?.toFixed(1) ?? '-'
                const tLast = xData[xData.length - 1]?.toFixed(1) ?? '-'
                console.debug(`[PromoterPanel] ${isNew ? 'CREATE' : 'APPEND'} key=${key} rawPts=${points.length} bandPts=${xData.length} t=${tFirst}..${tLast}`)
                if (xData.length > 0) {
                    xyyData.appendRange(xData, yTop, yBottom)
                }
            }
        }
        this.surface.resumeUpdates()
    }

    /**
     * Convert raw timeseries points into digital band arrays.
     * For each transition, we duplicate the point at the new time with the old state
     * (creating a step), then add the point with the new state.
     */
    private _buildBandArrays(
        series: Array<[number, number]>,
        yCenter: number,
        bandHeight: number
    ): { xData: number[]; yTop: number[]; yBottom: number[] } {
        const xData: number[] = []
        const yTop: number[] = []
        const yBottom: number[] = []

        for (let i = 0; i < series.length; i++) {
            const [time, state] = series[i]!

            // -1 is the gap marker between non-contiguous episodes: emit a NaN break
            if (state === -1) {
                xData.push(time)
                yTop.push(NaN)
                yBottom.push(NaN)
                continue
            }

            if (i > 0) {
                const prevState = series[i - 1]![1]
                // Skip the step-duplicate if the previous point was a gap marker
                if (prevState !== -1) {
                    const halfHeight = 0.5 * bandHeight * prevState
                    xData.push(time)
                    yTop.push(yCenter + halfHeight)
                    yBottom.push(yCenter - halfHeight)
                }
            }

            const halfHeight = 0.5 * bandHeight * state
            xData.push(time)
            yTop.push(yCenter + halfHeight)
            yBottom.push(yCenter - halfHeight)
        }

        return { xData, yTop, yBottom }
    }

    /**
     * Composable highlight for band fills: dims non-matching series.
     * Overrides BasePanel because FastBandRenderableSeries.opacity does not
     * affect the fillY1 area -- we must rewrite fillY1 with an alpha channel.
     */
    protected override _applyHighlightFilters(): void {
        for (const rs of this.surface.renderableSeries.asArray()) {
            if (!(rs instanceof FastBandRenderableSeries)) continue
            const name = rs.dataSeries?.dataSeriesName ?? ''
            const baseColour = this.keyColourMap.get(name)
            if (!baseColour) continue
            const matches = this._seriesMatchesFilters(name)
            rs.fillY1 = matches ? baseColour : withOpacity(baseColour, PATH_DIM_OPACITY)
            rs.strokeY1 = rs.fillY1
            rs.stroke = rs.fillY1
        }
    }

    /** Create a new XyyDataSeries + FastBandRenderableSeries for streaming. */
    private _createStreamingSeries(key: string, label: string): XyyDataSeries {
        const colour = this.metadata!.gene_colours[label] ?? this.theme.chart.fallbackSeries
        this.keyColourMap.set(key, colour)
        const xyyData = new XyyDataSeries(this.wasmContext, {
            isSorted: true,
            containsNaN: true,
            dataSeriesName: key
        })
        this.seriesMap.set(key, xyyData)

        const bandSeries = new FastBandRenderableSeries(this.wasmContext, {
            dataSeries: xyyData,
            stroke: colour,
            strokeThickness: 0.0,
            fillY1: colour,
            strokeY1: colour,
            drawNaNAs: ELineDrawMode.DiscontinuousLine
        })
        this.surface.renderableSeries.add(bandSeries)
        return xyyData
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
        this.bandParams.delete(key)
        this.keyColourMap.delete(key)
    }
}