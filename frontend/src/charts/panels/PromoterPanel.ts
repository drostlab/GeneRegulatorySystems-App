import {
    EAxisAlignment,
    EFillPaletteMode,
    ELineDrawMode,
    EResamplingMode,
    FastBandRenderableSeries,
    NumericAxis,
    SweepAnimation,
    XyyDataSeries,
    parseColorToUIntArgb,
    type IFillPaletteProvider,
    type IRenderableSeries,
} from "scichart"
import { TimeseriesPanel } from "./TimeseriesPanel"
import { PATH_DIM_OPACITY, type BasePanelOptions } from "./BasePanel"
import type { TimeseriesData, TimeseriesMetadata } from "@/types/simulation"
import { restructureTimeseriesByPathAndGene } from "@/types/simulation"
import { CHART_FONT_SIZES, AXIS_THICKNESS } from "../chartConstants"
import { setupTimeAxis } from "../timeFormat"

const SWEEP_DURATION_MS = 400

export type PathYRanges = Map<string, { yMin: number; yMax: number }>

export class PromoterPanel extends TimeseriesPanel {
    private pathYRanges: PathYRanges = new Map()

    /** Persistent data series map for streaming: `label:path` -> XyyDataSeries */
    private seriesMap: Map<string, XyyDataSeries> = new Map()

    /** Cached band layout params per series key: { yCenter, bandHeight } */
    private bandParams: Map<string, { yCenter: number; bandHeight: number }> = new Map()

    /** Activity value for each expanded SciChart vertex, used by palette providers. */
    private keyActivityMap: Map<string, number[]> = new Map()

    /** Highlight opacity multiplier per series key. */
    private keyHighlightOpacity: Map<string, number> = new Map()

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
        this.keyActivityMap.clear()
        this.keyHighlightOpacity.clear()
        // Note: bandParams is NOT cleared here -- it's layout, recomputed from setMetadata/setPathYRanges
        super.clearData()
    }

    setData(timeseries: TimeseriesData, { animate = true }: { animate?: boolean } = {}): void {
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
        this.surface.suspendUpdates()
        for (const [path, geneData] of Object.entries(dataByPath)) {
            const yRange = this.pathYRanges.get(path)
            if (!yRange) continue

            const pathGenes = scheduleGenes.filter(g => g in geneData)
            pathGenes.forEach((geneId) => {
                const { colour, series } = geneData[geneId]!
                const key = `${geneId}:${path}`
                const { yCenter, bandHeight } = this.bandParams.get(key)!
                const { xData, yTop, yBottom, activity } = this._buildBandArrays(series, yCenter, bandHeight)
                this.keyActivityMap.set(key, activity)

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

                    this.keyHighlightOpacity.set(key, 1)
                    const bandSeries = new FastBandRenderableSeries(this.wasmContext, {
                        dataSeries: xyyDataSeries,
                        stroke: colour,
                        strokeThickness: 0.0,
                        fillY1: colour,
                        strokeY1: colour,
                        drawNaNAs: ELineDrawMode.DiscontinuousLine,
                        resamplingMode: EResamplingMode.None,
                        animation: animate ? new SweepAnimation({ duration: SWEEP_DURATION_MS }) : undefined
                    })
                    bandSeries.paletteProvider = this._buildActivityPalette(key, colour)
                    this.surface.renderableSeries.add(bandSeries)
                }
            })
        }
        this.surface.resumeUpdates()
    }

    /**
     * Convert activity points into band arrays. Exact integer states retain the
     * original digital-band geometry; fractional viewport values use a narrow,
     * fixed-height density strip. Step duplication keeps bin edges sharp.
     */
    private _buildBandArrays(
        series: Array<[number, number]>,
        yCenter: number,
        bandHeight: number
    ): { xData: number[]; yTop: number[]; yBottom: number[]; activity: number[] } {
        const xData: number[] = []
        const yTop: number[] = []
        const yBottom: number[] = []
        const activity: number[] = []
        const isDensity = series.some(([, state]) =>
            state !== -1 && Math.abs(state - Math.round(state)) > 1e-9
        )
        const densityHalfHeight = 0.5 * bandHeight

        const halfHeightFor = (state: number): number => isDensity
            ? densityHalfHeight
            : 0.5 * bandHeight * state

        for (let i = 0; i < series.length; i++) {
            const [time, state] = series[i]!

            // -1 is the gap marker between non-contiguous episodes: emit a NaN break
            if (state === -1) {
                xData.push(time)
                yTop.push(NaN)
                yBottom.push(NaN)
                activity.push(0)
                continue
            }

            if (i > 0) {
                const prevState = series[i - 1]![1]
                // Skip the step-duplicate if the previous point was a gap marker
                if (prevState !== -1) {
                    const halfHeight = halfHeightFor(prevState)
                    xData.push(time)
                    yTop.push(yCenter + halfHeight)
                    yBottom.push(yCenter - halfHeight)
                    activity.push(prevState)
                }
            }

            const halfHeight = halfHeightFor(state)
            xData.push(time)
            yTop.push(yCenter + halfHeight)
            yBottom.push(yCenter - halfHeight)
            activity.push(state)
        }

        return { xData, yTop, yBottom, activity }
    }

    /** Colour the fixed-height activity strip with alpha proportional to occupancy. */
    private _buildActivityPalette(key: string, colour: string): IFillPaletteProvider {
        const rgb = parseColorToUIntArgb(colour) & 0x00ffffff
        return {
            fillPaletteMode: EFillPaletteMode.SOLID,
            isRangeIndependant: true,
            onAttached(_series: IRenderableSeries): void {},
            onDetached(): void {},
            shouldUpdatePalette: (): boolean => true,
            overrideFillArgb: (_x: number, _y: number, index: number): number => {
                const value = this.keyActivityMap.get(key)?.[index] ?? 0
                const highlight = this.keyHighlightOpacity.get(key) ?? 1
                const alpha = Math.round(255 * Math.min(1, Math.max(0, value)) * highlight)
                return (((alpha << 24) | rgb) >>> 0)
            },
        }
    }

    /**
     * Composable highlight for activity-density fills. Highlight opacity becomes
     * a multiplier in the per-point palette rather than replacing its alpha.
     */
    protected override _applyHighlightFilters(): void {
        for (const rs of this.surface.renderableSeries.asArray()) {
            if (!(rs instanceof FastBandRenderableSeries)) continue
            const name = rs.dataSeries?.dataSeriesName ?? ''
            this.keyHighlightOpacity.set(
                name,
                this._seriesMatchesFilters(name) ? 1 : PATH_DIM_OPACITY,
            )
        }
        this.surface.invalidateElement()
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
        this.keyActivityMap.delete(key)
        this.keyHighlightOpacity.delete(key)
    }
}
