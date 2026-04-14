/**
 * PhaseSpacePanel -- BasePanel subclass for phase-space embedding views.
 *
 * Renders per-path trajectory lines + scatter points as a SciChartSubSurface.
 * Supports timepoint highlighting, hover tooltips (via PhaseSpaceHoverModifier),
 * path dimming, and click selection with full cross-panel sync.
 */
import {
    NumericAxis,
    XyDataSeries,
    FastLineRenderableSeries,
    XyScatterRenderableSeries,
    EllipsePointMarker,
    MouseWheelZoomModifier,
    ZoomPanModifier,
    ZoomExtentsModifier,
    parseColorToUIntArgb,
    EStrokePaletteMode,
    type IPointMarkerPaletteProvider,
    type TPointMarkerArgb,
    type IRenderableSeries,
} from "scichart"
import { BasePanel, PATH_DIM_OPACITY, type BasePanelOptions } from "./BasePanel"
import type { PhaseSpacePoint, PhaseSpaceResult } from "@/types/simulation"
import { CHART_FONT_SIZES } from "../chartConstants"
import { PhaseSpaceHoverModifier } from "../modifiers/PhaseSpaceHoverModifier"
export type { HoverInfo } from "../modifiers/PhaseSpaceHoverModifier"

const LINE_ALPHA = 0.9
const POINT_SIZE = 3.5
const HIGHLIGHT_SIZE = 14

/** Stroke thickness / point size for highlighted / dimmed path (external highlight). */
const LINE_THICKNESS_NORMAL = 1
const LINE_THICKNESS_HOVER = 2.0
const POINT_SIZE_HOVER = 5
const POINT_SIZE_DIM = 2

/**
 * Build a point-marker PaletteProvider that assigns each scatter point its own colour.
 */
function buildPointPalette(colours: string[]): IPointMarkerPaletteProvider {
    const argbs = colours.map(c => parseColorToUIntArgb(c))
    return {
        strokePaletteMode: EStrokePaletteMode.SOLID,
        onAttached(_series: IRenderableSeries): void {},
        onDetached(): void {},
        overridePointMarkerArgb(_x: number, _y: number, index: number): TPointMarkerArgb {
            const c = argbs[index] ?? 0xffffffff
            return { fill: c, stroke: c }
        },
    }
}

type PathSelectCallback = (path: string) => void

/** Append alpha to a '#rrggbb' hex colour. */
function withAlpha(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r},${g},${b},${alpha})`
}


export class PhaseSpacePanel extends BasePanel {
    // Retained as panel state for dispose/clear.
    // @ts-expect-error written but not read (tracked for lifecycle)
    private result?: PhaseSpaceResult
    private highlightData?: XyDataSeries
    private highlightSeries?: XyScatterRenderableSeries
    private pathLineData = new Map<string, XyDataSeries>()
    private pathScatterData = new Map<string, XyDataSeries>()
    private pathLineSeries = new Map<string, FastLineRenderableSeries>()
    private pathScatterSeries = new Map<string, XyScatterRenderableSeries>()
    /** Pre-sorted (by t) points per path -- for highlight and hit-test. */
    private pathPoints = new Map<string, PhaseSpacePoint[]>()
    // @ts-expect-error written but not read (tracked for lifecycle)
    private pathSelectCallback?: PathSelectCallback
    private hoverModifier: PhaseSpaceHoverModifier

    constructor(options: BasePanelOptions) {
        super(options)

        const xAxis = new NumericAxis(this.wasmContext, {
            axisTitle: "",
            labelStyle: { fontSize: CHART_FONT_SIZES.label },
            axisTitleStyle: { fontSize: CHART_FONT_SIZES.title },
            drawMajorBands: false,
            drawMinorGridLines: false,
        })
        const yAxis = new NumericAxis(this.wasmContext, {
            axisTitle: "",
            labelStyle: { fontSize: CHART_FONT_SIZES.label },
            axisTitleStyle: { fontSize: CHART_FONT_SIZES.title },
            drawMajorBands: false,
            drawMinorGridLines: false,
            majorGridLineStyle: { color: this.theme.chart.gridLine },
            minorGridLineStyle: { color: this.theme.chart.gridLine },
        })
        this.surface.xAxes.add(xAxis)
        this.surface.yAxes.add(yAxis)

        // Phase space has its own zoom/pan (independent of timeseries)
        this.surface.chartModifiers.add(new MouseWheelZoomModifier())
        this.surface.chartModifiers.add(new ZoomPanModifier())
        this.surface.chartModifiers.add(new ZoomExtentsModifier())

        // Hover modifier handles hit-testing, tooltip, and path dimming
        this.hoverModifier = new PhaseSpaceHoverModifier()
        this.surface.chartModifiers.add(this.hoverModifier)

        this._createHighlightSeries()
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /** Set the phase-space result, rebuilding all series. */
    setPhaseSpaceData(result: PhaseSpaceResult): void {
        this._clearPathSeries()
        this.result = result

        // Group + sort by t
        const byPath = new Map<string, PhaseSpacePoint[]>()
        for (const pt of result.points) {
            const arr = byPath.get(pt.path)
            if (arr) arr.push(pt)
            else byPath.set(pt.path, [pt])
        }
        byPath.forEach(pts => pts.sort((a, b) => a.t - b.t))

        // Update axis titles
        const xAxis = this.surface.xAxes.get(0)
        const yAxis = this.surface.yAxes.get(0)
        if (xAxis) xAxis.axisTitle = result.axis_labels[0] ?? ""
        if (yAxis) yAxis.axisTitle = result.axis_labels[1] ?? ""

        // Temporarily remove highlight so new series go underneath, then re-add
        this.surface.renderableSeries.remove(this.highlightSeries!)

        // Build all series first, then add lines before scatters so points always render on top
        byPath.forEach((pts, path) => {
            const xs = pts.map(p => p.x)
            const ys = pts.map(p => p.y)
            const pathColour = this.theme.phaseSpace.trajectoryLine

            const lineData = new XyDataSeries(this.wasmContext, {
                isSorted: false,
                dataSeriesName: `line:${path}`,
            })
            lineData.appendRange(xs, ys)

            const scatterData = new XyDataSeries(this.wasmContext, {
                isSorted: false,
                dataSeriesName: `scatter:${path}`,
            })
            scatterData.appendRange(xs, ys)

            const lineSeries = new FastLineRenderableSeries(this.wasmContext, {
                dataSeries: lineData,
                stroke: withAlpha(pathColour, LINE_ALPHA),
                strokeThickness: 1.5,
            })
            const scatterSeries = new XyScatterRenderableSeries(this.wasmContext, {
                dataSeries: scatterData,
                pointMarker: new EllipsePointMarker(this.wasmContext, {
                    width: POINT_SIZE,
                    height: POINT_SIZE,
                    fill: pathColour,  // fallback; overridden per-point by paletteProvider
                    stroke: "transparent",
                    strokeThickness: 0,
                }),
                paletteProvider: buildPointPalette(pts.map(p => p.colour)),
            })

            this.pathLineData.set(path, lineData)
            this.pathScatterData.set(path, scatterData)
            this.pathLineSeries.set(path, lineSeries)
            this.pathScatterSeries.set(path, scatterSeries)
            this.pathPoints.set(path, pts)
        })

        // All lines first, then all scatter points on top
        for (const lineSeries of this.pathLineSeries.values()) {
            this.surface.renderableSeries.add(lineSeries)
        }
        for (const scatterSeries of this.pathScatterSeries.values()) {
            this.surface.renderableSeries.add(scatterSeries)
        }

        // Highlight always on top
        this.surface.renderableSeries.add(this.highlightSeries!)

        // Feed path -> time[] into hover modifier for tooltip resolution
        const pathTimes = new Map<string, number[]>()
        byPath.forEach((pts, path) => pathTimes.set(path, pts.map(p => p.t)))
        this.hoverModifier.setPathTimes(pathTimes)

        this.surface.zoomExtents()
        console.debug(`[PhaseSpacePanel] setData: ${byPath.size} paths, ${result.n_cells} cells, method=${result.method}`)
    }

    /** Update the current-timepoint highlight: one hollow circle per path nearest to t. */
    setTimepoint(t: number): void {
        if (!this.highlightData) return
        this.highlightData.clear()
        let resolvedT: number | undefined
        this.pathPoints.forEach(pts => {
            if (pts.length === 0) return
            let nearest = pts[0]!
            let bestDist = Math.abs(nearest.t - t)
            for (let i = 1; i < pts.length; i++) {
                const d = Math.abs(pts[i]!.t - t)
                if (d < bestDist) { bestDist = d; nearest = pts[i]! }
            }
            this.highlightData!.append(nearest.x, nearest.y)
            if (resolvedT === undefined) resolvedT = nearest.t
        })
    }

    /** Register a callback fired when the user clicks on a trajectory path. */
    onPathSelect(cb: PathSelectCallback): void {
        this.pathSelectCallback = cb
    }

    /** Register a callback fired on hover (nearest point info) or null on leave. */
    onHover(cb: (info: { t: number; path: string } | null) => void): void {
        this.hoverModifier.onHover(cb)
    }

    /**
     * Override: skip when hover modifier is active (it manages its own dimming).
     * Otherwise dim non-matching paths and boost the highlighted path.
     * Gene filter is a no-op for phase space (series are `line:<path>`, not `<gene>:<path>`).
     */
    override highlightGene(_gene: string | null): void {
        // Phase space has no gene concept in series naming — intentional no-op.
    }

    /**
     * Override: skip when hover modifier is active (it manages its own dimming).
     * Otherwise dim non-matching paths and boost the highlighted path.
     */
    protected override _applyHighlightFilters(): void {
        if (this.hoverModifier.isHovering) return
        const path = this._highlightedPath
        for (const rs of this.surface.renderableSeries.asArray()) {
            const name = rs.dataSeries?.dataSeriesName ?? ''
            if (name.startsWith('__')) continue
            const isLine = name.startsWith('line:')
            const isScatter = name.startsWith('scatter:')
            if (!isLine && !isScatter) continue
            const seriesPath = name.substring(name.indexOf(':') + 1)
            const matches = path === null || seriesPath === path
            rs.opacity = matches ? 1 : PATH_DIM_OPACITY
            if (isLine && rs instanceof FastLineRenderableSeries) {
                rs.strokeThickness = (matches && path !== null) ? LINE_THICKNESS_HOVER : LINE_THICKNESS_NORMAL
            }
            if (isScatter && rs instanceof XyScatterRenderableSeries && rs.pointMarker) {
                const sz = path === null ? POINT_SIZE : (matches ? POINT_SIZE_HOVER : POINT_SIZE_DIM)
                rs.pointMarker.width = sz
                rs.pointMarker.height = sz
            }
        }
    }

    override clearData(): void {
        this._clearPathSeries()
        this.result = undefined
        super.clearData()
        this._createHighlightSeries()
    }

    override dispose(): void {
        this._clearPathSeries()
        this.result = undefined
        this.hoverModifier.dispose()
        // Skip clearData()/highlight recreation -- surface.delete() handles full cleanup.
    }

    /** Re-apply theme; update highlight marker stroke colour and trajectory lines. */
    override applyTheme(isDark: boolean): void {
        super.applyTheme(isDark)
        if (this.highlightSeries?.pointMarker) {
            this.highlightSeries.pointMarker.stroke = this.theme.text.base
        }
        // Update trajectory line colours
        const lineColour = this.theme.phaseSpace.trajectoryLine
        for (const lineSeries of this.pathLineSeries.values()) {
            lineSeries.stroke = withAlpha(lineColour, LINE_ALPHA)
        }
    }

    /** Not applicable for phase-space (no time x-axis). */
    override setTimeExtent(_min: number, _max: number): void {
        // no-op: phase space axes are data-space, not time
    }

    override setVisibleTimeRange(_min: number, _max: number): void {
        // no-op
    }

    // ------------------------------------------------------------------
    // Highlight series
    // ------------------------------------------------------------------

    /** Create the highlight series (hollow circle at current timepoint). */
    private _createHighlightSeries(): void {
        this.highlightData = new XyDataSeries(this.wasmContext, {
            isSorted: false,
            dataSeriesName: "__highlight__",
        })
        this.highlightSeries = new XyScatterRenderableSeries(this.wasmContext, {
            dataSeries: this.highlightData,
            pointMarker: new EllipsePointMarker(this.wasmContext, {
                width: HIGHLIGHT_SIZE,
                height: HIGHLIGHT_SIZE,
                fill: "transparent",
                stroke: this.theme.text.base,
                strokeThickness: 2.5,
            }),
        })
        this.surface.renderableSeries.add(this.highlightSeries)
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /** Remove and delete all path series (line + scatter). Leaves highlight intact. */
    private _clearPathSeries(): void {
        for (const [path, rs] of this.pathLineSeries) {
            this.surface.renderableSeries.remove(rs)
            rs.delete()
            this.pathLineData.get(path)?.delete()
        }
        for (const [path, rs] of this.pathScatterSeries) {
            this.surface.renderableSeries.remove(rs)
            rs.delete()
            this.pathScatterData.get(path)?.delete()
        }
        this.pathLineSeries.clear()
        this.pathScatterSeries.clear()
        this.pathLineData.clear()
        this.pathScatterData.clear()
        this.pathPoints.clear()
    }
}
