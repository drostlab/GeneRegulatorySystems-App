import { EAxisAlignment, ELineDrawMode, ENumericFormat, FastBandRenderableSeries, FastLineRenderableSeries, LeftAlignedOuterVerticallyStackedAxisLayoutStrategy, NumberRange, NumericAxis, SweepAnimation, XyDataSeries, XyyDataSeries } from "scichart";
import { TimeseriesPanel } from "./TimeseriesPanel";
import { extractGene, extractPath, type BasePanelOptions } from "./BasePanel";
import type { TimeseriesData } from "@/types/simulation";
import type { GeneLayout, PathDisplay, TimeseriesSummary } from "@/types/displayModes";
import { getGeneFromSpeciesName } from "@/types/schedule";
import { CHART_FONT_SIZES, AXIS_THICKNESS_NARROW } from "../chartConstants";
import { setupTimeAxis } from "../timeFormat";
import { withOpacity } from "@/utils/colorUtils";

const SWEEP_DURATION_MS = 400
const SE_BAND_OPACITY = 0.25


export class CountsPanel extends TimeseriesPanel {
    /** Persistent data series map for streaming: `geneId:path` -> XyDataSeries */
    private seriesMap: Map<string, XyDataSeries> = new Map()
    /** Mean+SE data series: `geneId` -> { line: XyDataSeries, band: XyyDataSeries } */
    private summarySeriesMap: Map<string, { line: XyDataSeries; band: XyyDataSeries }> = new Map()

    private title: string
    private _geneLayout: GeneLayout = 'overlaid'
    private _pathDisplay: PathDisplay = 'overlaid'

    /** The default y-axis ID (used in overlaid gene mode). */
    private readonly defaultYAxisId: string

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

        const yAxis = new NumericAxis(this.wasmContext, {
            id: "defaultY",
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
        this.defaultYAxisId = yAxis.id

        this.surface.xAxes.add(xAxis)
        this.surface.yAxes.add(yAxis)
    }

    // =========================================================================
    // Display mode
    // =========================================================================

    setGeneLayout(mode: GeneLayout): void {
        if (mode === this._geneLayout) return
        this._geneLayout = mode
        this._rebuildStackedAxes()
    }

    setPathDisplay(mode: PathDisplay): void {
        if (mode === this._pathDisplay) return
        const prev = this._pathDisplay
        this._pathDisplay = mode
        // When switching away from mean-se, clear summary series
        if (prev === 'mean-se') {
            this._clearSummarySeries()
        }
        this._rebuildStackedAxes()
    }

    // =========================================================================
    // Stacked axis management (gene, path, or gene x path)
    // =========================================================================

    /**
     * Rebuild y-axes based on current gene layout and path display modes.
     * Composes into: single axis, per-gene, per-path, or per-gene-x-path.
     */
    private _rebuildStackedAxes(): void {
        const geneStacked = this._geneLayout === 'stacked'
        const pathStacked = this._pathDisplay === 'stacked'

        if (!geneStacked && !pathStacked) {
            this._revertToSingleAxis()
            return
        }

        const genes = this._collectCurrentGenes()
        const paths = this._collectCurrentPaths()
        if (genes.length === 0 && paths.length === 0) return

        // Determine axis keys
        const axisKeys: Array<{ id: string; label: string; colour: string | undefined }> = []
        if (geneStacked && pathStacked) {
            for (const gene of genes) {
                for (const path of paths) {
                    axisKeys.push({
                        id: `stk_${gene}_${path}`,
                        label: `${gene} : ${path}`,
                        colour: this.metadata?.gene_colours[gene]
                    })
                }
            }
        } else if (geneStacked) {
            for (const gene of genes) {
                axisKeys.push({
                    id: `gene_${gene}`,
                    label: gene,
                    colour: this.metadata?.gene_colours[gene]
                })
            }
        } else {
            for (const path of paths) {
                axisKeys.push({
                    id: `path_${path}`,
                    label: path,
                    colour: undefined
                })
            }
        }

        this._applyStackedAxes(axisKeys)

        // Reassign existing series to their correct axis
        for (const rs of this.surface.renderableSeries.asArray()) {
            const name = rs.dataSeries?.dataSeriesName ?? ''
            rs.yAxisId = this._resolveAxisId(name)
        }
    }

    /** Collect unique gene IDs from the current seriesMap. */
    private _collectCurrentGenes(): string[] {
        const genes = new Set<string>()
        for (const key of this.seriesMap.keys()) {
            const gene = extractGene(key)
            if (gene) genes.add(gene)
        }
        // Also check summary series
        for (const gene of this.summarySeriesMap.keys()) {
            genes.add(gene)
        }
        return [...genes]
    }

    /** Collect unique path IDs from the current seriesMap. */
    private _collectCurrentPaths(): string[] {
        const paths = new Set<string>()
        for (const key of this.seriesMap.keys()) {
            const path = extractPath(key)
            if (path) paths.add(path)
        }
        return [...paths]
    }

    /** Apply stacked y-axes with the given key/label/colour list. */
    private _applyStackedAxes(axisKeys: Array<{ id: string; label: string; colour: string | undefined }>): void {
        // Set stacked layout strategy
        this.surface.layoutManager.leftOuterAxesLayoutStrategy =
            new LeftAlignedOuterVerticallyStackedAxisLayoutStrategy()

        // Remove all existing y-axes except default
        const existingIds = this.surface.yAxes.asArray().map(a => a.id)
        for (const id of existingIds) {
            if (id === this.defaultYAxisId) continue
            const axis = this.surface.yAxes.getById(id)
            if (axis) this.surface.yAxes.remove(axis)
        }

        // Hide default axis
        const defaultAxis = this.surface.yAxes.getById(this.defaultYAxisId)
        if (defaultAxis) defaultAxis.isVisible = false

        const pct = Math.floor(100 / axisKeys.length)
        for (const { id, label, colour } of axisKeys) {
            if (this.surface.yAxes.getById(id)) continue
            const resolvedColour = colour ?? this.theme.chart.fallbackSeries
            const axis = new NumericAxis(this.wasmContext, {
                id,
                axisTitle: label,
                axisAlignment: EAxisAlignment.Left,
                labelFormat: ENumericFormat.Decimal,
                labelPrecision: 0,
                labelStyle: { fontSize: CHART_FONT_SIZES.label, color: resolvedColour },
                axisTitleStyle: { fontSize: CHART_FONT_SIZES.title, color: resolvedColour },
                drawMajorBands: false,
                drawMajorTickLines: false,
                drawMinorTickLines: false,
                growBy: new NumberRange(0.01, 0.01),
                majorGridLineStyle: { color: this.theme.chart.gridLine },
                minorGridLineStyle: { color: this.theme.chart.gridLine },
                stackedAxisLength: `${pct}%`,
                axisThickness: AXIS_THICKNESS_NARROW
            })
            this.surface.yAxes.add(axis)
        }
    }

    /** Revert to single shared y-axis. */
    private _revertToSingleAxis(): void {
        // Remove all stacked axes
        const toRemove = this.surface.yAxes.asArray().filter(a => a.id !== this.defaultYAxisId)
        for (const axis of toRemove) {
            this.surface.yAxes.remove(axis)
        }

        // Show and restore default axis
        const defaultAxis = this.surface.yAxes.getById(this.defaultYAxisId)
        if (defaultAxis) {
            defaultAxis.isVisible = true
            defaultAxis.axisTitle = this.title
        }

        // Reassign all series to default axis
        for (const rs of this.surface.renderableSeries.asArray()) {
            rs.yAxisId = this.defaultYAxisId
        }

        // Reset layout strategy (SciChart default)
        this.surface.layoutManager.leftOuterAxesLayoutStrategy = undefined as any
    }

    /**
     * Resolve the correct y-axis ID for a series based on its name
     * and current gene/path display modes.
     * Handles both normal series ("gene:path") and summary series ("__mean_gene", "__se_gene").
     */
    private _resolveAxisId(seriesName: string): string {
        let gene: string | null = null
        let path: string | null = null

        if (seriesName.startsWith('__mean_') || seriesName.startsWith('__se_')) {
            gene = seriesName.replace(/^__(mean|se)_/, '')
        } else {
            gene = extractGene(seriesName)
            path = extractPath(seriesName)
        }

        const geneStacked = this._geneLayout === 'stacked'
        const pathStacked = this._pathDisplay === 'stacked'

        if (geneStacked && pathStacked && gene && path) {
            return `stk_${gene}_${path}`
        }
        if (geneStacked && gene) {
            return `gene_${gene}`
        }
        if (pathStacked && path) {
            return `path_${path}`
        }
        return this.defaultYAxisId
    }

    /**
     * Ensure a stacked axis exists for a new series key.
     * Handles gene, path, or gene×path stacking.
     */
    private _ensureStackedAxis(gene: string, path: string): void {
        const geneStacked = this._geneLayout === 'stacked'
        const pathStacked = this._pathDisplay === 'stacked'
        if (!geneStacked && !pathStacked) return

        let axisId: string
        let label: string
        let colour: string | undefined

        if (geneStacked && pathStacked) {
            axisId = `stk_${gene}_${path}`
            label = `${gene} : ${path}`
            colour = this.metadata?.gene_colours[gene]
        } else if (geneStacked) {
            axisId = `gene_${gene}`
            label = gene
            colour = this.metadata?.gene_colours[gene]
        } else {
            axisId = `path_${path}`
            label = path
            colour = undefined
        }

        if (this.surface.yAxes.getById(axisId)) return

        // Ensure stacked strategy is set
        if (!this.surface.layoutManager.leftOuterAxesLayoutStrategy) {
            this.surface.layoutManager.leftOuterAxesLayoutStrategy =
                new LeftAlignedOuterVerticallyStackedAxisLayoutStrategy()
        }

        const resolvedColour = colour ?? this.theme.chart.fallbackSeries
        const allStacked = this.surface.yAxes.asArray().filter(a => a.id !== this.defaultYAxisId)
        const pct = Math.floor(100 / (allStacked.length + 1))

        const axis = new NumericAxis(this.wasmContext, {
            id: axisId,
            axisTitle: label,
            axisAlignment: EAxisAlignment.Left,
            labelFormat: ENumericFormat.Decimal,
            labelPrecision: 0,
            labelStyle: { fontSize: CHART_FONT_SIZES.label, color: resolvedColour },
            axisTitleStyle: { fontSize: CHART_FONT_SIZES.title, color: resolvedColour },
            drawMajorBands: false,
            drawMajorTickLines: false,
            drawMinorTickLines: false,
            growBy: new NumberRange(0.01, 0.01),
            majorGridLineStyle: { color: this.theme.chart.gridLine },
            minorGridLineStyle: { color: this.theme.chart.gridLine },
            stackedAxisLength: `${pct}%`,
            axisThickness: AXIS_THICKNESS_NARROW
        })
        this.surface.yAxes.add(axis)

        // Update percentages for all stacked axes
        for (const a of this.surface.yAxes.asArray()) {
            if (a.id !== this.defaultYAxisId) {
                a.stackedAxisLength = `${pct}%`
            }
        }
    }

    // =========================================================================
    // Standard timeseries data
    // =========================================================================

    override clearData(): void {
        this.seriesMap.clear()
        this._clearSummarySeries()
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

        // Clear any mean+SE series when raw data is being set
        this._clearSummarySeries()

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
                    this._ensureStackedAxis(geneId, path)
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
                        animation: new SweepAnimation({ duration: SWEEP_DURATION_MS }),
                        yAxisId: this._resolveAxisId(key)
                    })
                    this.surface.renderableSeries.add(lineSeries)
                    created++
                }
            }
        }
        if (created > 0) {
            console.debug(`[CountsPanel] setData: created ${created} new series, ${this.seriesMap.size} total`)
        }

        // Rebuild stacked axes if new series appeared
        if ((this._geneLayout === 'stacked' || this._pathDisplay === 'stacked') && created > 0) {
            this._rebuildStackedAxes()
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

    // =========================================================================
    // Mean+SE rendering
    // =========================================================================

    /** Set mean+SE summary data (replaces normal timeseries series). */
    setMeanSEData(summary: TimeseriesSummary): void {
        if (!this.metadata) return

        // Clear normal timeseries series (they're hidden in mean-se mode)
        this._clearNormalSeries()

        const incomingGenes = new Set<string>()
        for (const species of Object.keys(summary)) {
            const gene = getGeneFromSpeciesName(species)
            if (gene) incomingGenes.add(gene)
        }

        // Remove stale summary series
        for (const gene of [...this.summarySeriesMap.keys()]) {
            if (!incomingGenes.has(gene)) {
                this._removeSummarySeries(gene)
            }
        }

        for (const [species, data] of Object.entries(summary)) {
            const gene = getGeneFromSpeciesName(species)
            if (!gene) continue

            this._ensureStackedAxis(gene, '')
            const colour = this.metadata.gene_colours[gene] ?? this.theme.chart.fallbackSeries
            const yAxisId = this._resolveAxisId(`__mean_${gene}`)

            const existing = this.summarySeriesMap.get(gene)
            if (existing) {
                // Update in place
                existing.line.clear()
                existing.line.appendRange(data.time, data.mean)
                existing.band.clear()
                const upper = data.mean.map((m, i) => m + data.se[i]!)
                const lower = data.mean.map((m, i) => m - data.se[i]!)
                existing.band.appendRange(data.time, upper, lower)
            } else {
                // Create mean line
                const lineSeries = new XyDataSeries(this.wasmContext, {
                    isSorted: true,
                    dataSeriesName: `__mean_${gene}`
                })
                lineSeries.appendRange(data.time, data.mean)

                const lineRenderable = new FastLineRenderableSeries(this.wasmContext, {
                    dataSeries: lineSeries,
                    stroke: colour,
                    strokeThickness: 2,
                    animation: new SweepAnimation({ duration: SWEEP_DURATION_MS }),
                    yAxisId
                })
                this.surface.renderableSeries.add(lineRenderable)

                // Create SE band
                const upper = data.mean.map((m, i) => m + data.se[i]!)
                const lower = data.mean.map((m, i) => m - data.se[i]!)
                const bandSeries = new XyyDataSeries(this.wasmContext, {
                    isSorted: true,
                    dataSeriesName: `__se_${gene}`
                })
                bandSeries.appendRange(data.time, upper, lower)

                const bandRenderable = new FastBandRenderableSeries(this.wasmContext, {
                    dataSeries: bandSeries,
                    stroke: withOpacity(colour, SE_BAND_OPACITY),
                    strokeThickness: 0,
                    fill: withOpacity(colour, SE_BAND_OPACITY),
                    fillY1: withOpacity(colour, SE_BAND_OPACITY),
                    yAxisId
                })
                this.surface.renderableSeries.add(bandRenderable)

                this.summarySeriesMap.set(gene, { line: lineSeries, band: bandSeries })
            }
        }

        if (this._geneLayout === 'stacked') {
            this._rebuildStackedAxes()
        }
        console.debug(`[CountsPanel] setMeanSEData: ${this.summarySeriesMap.size} genes`)
    }

    // =========================================================================
    // Internal helpers
    // =========================================================================

    /** Create a new XyDataSeries + FastLineRenderableSeries for a streaming key. */
    private _createStreamingSeries(key: string, geneId: string): XyDataSeries {
        const path = extractPath(key) ?? ''
        this._ensureStackedAxis(geneId, path)
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
            drawNaNAs: ELineDrawMode.DiscontinuousLine,
            yAxisId: this._resolveAxisId(key)
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

    /** Clear all normal (non-summary) series. */
    private _clearNormalSeries(): void {
        for (const key of [...this.seriesMap.keys()]) {
            this._removeRenderableSeries(key)
        }
        this.seriesMap.clear()
    }

    /** Remove summary (mean+SE) series for a gene. */
    private _removeSummarySeries(gene: string): void {
        const entry = this.summarySeriesMap.get(gene)
        if (!entry) return
        for (const ds of [entry.line, entry.band]) {
            const rs = this.surface.renderableSeries.asArray().find(r => r.dataSeries === ds)
            if (rs) {
                this.surface.renderableSeries.remove(rs)
                rs.delete()
            }
            ds.delete()
        }
        this.summarySeriesMap.delete(gene)
    }

    /** Clear all summary (mean+SE) series. */
    private _clearSummarySeries(): void {
        for (const gene of [...this.summarySeriesMap.keys()]) {
            this._removeSummarySeries(gene)
        }
    }
}
