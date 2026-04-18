import {
    EAxisAlignment,
    EllipsePointMarker,
    FastLineRenderableSeries,
    LineAnnotation,
    NumericAxis,
    NumberRange,
    XyDataSeries,
    XyScatterRenderableSeries,
    type AnnotationBase
} from "scichart"
import { BasePanel, PATH_DIM_OPACITY, type BasePanelOptions } from "./BasePanel"
import { layoutLines, type LayoutLine, type LayoutInstant, type LayoutBranchConnector, type LineLayoutResult } from "../layout/lineLayout"
import type { StructureNode, TimelineSegment } from "@/types/schedule"
import { setSvgAnnotationsVisible } from "../svgAnnotationVisibility"
import { buildChannelColourMap } from "@/utils/colorUtils"
import { CHART_FONT_SIZES, AXIS_THICKNESS } from "../chartConstants"
import { setupTimeAxis, formatTime } from "../timeFormat"
import logging from "@/utils/logging"

const log = logging.getLogger('TimelinePanel')

/** Line thickness for execution path lines. */
const LINE_THICKNESS = 3.0
const LINE_THICKNESS_HOVER = 5.0

/** Instant marker radius. */
const INSTANT_MARKER_RADIUS = 5
const INSTANT_MARKER_RADIUS_HOVER = 7

/** Branch connector line thickness. */
const CONNECTOR_THICKNESS = 2.0

export type HoverChangeCallback = (modelPath: string | null, executionPath: string | null) => void

export class TimelinePanel extends BasePanel {
    private hoverChangeCallback?: HoverChangeCallback
    private instantHoverChangeCallback?: (path: string | null) => void
    private drillInCallback?: (executionPath: string) => void

    /** Track data annotations so we can clear only them. */
    private dataAnnotations = new Set<AnnotationBase>()

    /** Currently hovered execution path. */
    private currentHoveredExecution: string | null = null

    /** DOM tooltip for hover labels. */
    private tooltipDiv: HTMLDivElement | null = null
    private lastMouseClient: { x: number; y: number } = { x: 0, y: 0 }
    private readonly onMouseMove = (e: MouseEvent) => { this.lastMouseClient = { x: e.clientX, y: e.clientY } }
    private readonly onDblClick = () => {
        if (this.currentHoveredExecution && this.drillInCallback) {
            this.drillInCallback(this.currentHoveredExecution)
        }
    }

    /** Per-channel fill colours (theme-aware). */
    private channelColourMap = new Map<string, string>()

    /** Maps segmentId -> series for line segments. */
    private lineSeriesMap = new Map<number, FastLineRenderableSeries>()

    /** Maps segmentId -> metadata for quick lookup. */
    private lineMetaMap = new Map<number, LayoutLine>()
    private instantMetaMap = new Map<number, LayoutInstant>()

    /** Connector annotations for branch points. */
    private connectorAnnotations: LineAnnotation[] = []
    private connectorMeta: LayoutBranchConnector[] = []

    /** Scatter series for instant markers. */
    private instantScatterSeries: XyScatterRenderableSeries | null = null
    /** Mapping from scatter point index to instant metadata. */
    private instantIndexMap: LayoutInstant[] = []

    /** Layout result for external consumers. */
    private layoutResult: LineLayoutResult | null = null

    constructor(options: BasePanelOptions) {
        super(options)

        const xAxis = new NumericAxis(this.wasmContext, {
            axisTitle: "Time",
            labelStyle: { fontSize: CHART_FONT_SIZES.label },
            axisTitleStyle: { fontSize: CHART_FONT_SIZES.title },
            drawMajorBands: false,
            drawMajorGridLines: false,
            drawMinorGridLines: false
        })
        setupTimeAxis(xAxis)

        const yAxis = new NumericAxis(this.wasmContext, {
            axisTitle: "Schedule",
            axisAlignment: EAxisAlignment.Left,
            axisTitleStyle: { fontSize: CHART_FONT_SIZES.title },
            drawMajorBands: false,
            drawLabels: false,
            drawMajorGridLines: false,
            drawMinorGridLines: false,
            drawMajorTickLines: false,
            drawMinorTickLines: false,
            axisThickness: AXIS_THICKNESS
        })

        this.surface.xAxes.add(xAxis)
        this.surface.yAxes.add(yAxis)

        this.parentSurface.domCanvas2D.addEventListener('mousemove', this.onMouseMove)
        this.parentSurface.domCanvas2D.addEventListener('dblclick', this.onDblClick)
    }

    onHoverChange(callback: HoverChangeCallback): void {
        this.hoverChangeCallback = callback
    }

    onInstantHoverChange(callback: (path: string | null) => void): void {
        this.instantHoverChangeCallback = callback
    }

    onDrillIn(callback: (executionPath: string) => void): void {
        this.drillInCallback = callback
    }

    // Keep API compat — segment click is now a no-op (lines don't have click-to-zoom)
    onSegmentClick(_callback: (segmentId: number, modelPath: string) => void): void {
        // No-op: line-based timeline does not support segment selection
    }

    override dispose(): void {
        this.parentSurface.domCanvas2D.removeEventListener('mousemove', this.onMouseMove)
        this.parentSurface.domCanvas2D.removeEventListener('dblclick', this.onDblClick)
        this.tooltipDiv?.remove()
        super.dispose()
    }

    override get isVisible(): boolean {
        return super.isVisible
    }

    override set isVisible(value: boolean) {
        super.isVisible = value
        this.setAnnotationsVisible(value)
    }

    override applyTheme(isDark: boolean): void {
        super.applyTheme(isDark)
        const tl = this.theme.timeline

        // Rebuild channel colour map
        const channels = [...this.channelColourMap.keys()].filter(c => c !== '')
        this.channelColourMap = buildChannelColourMap(channels, tl.rect.colour)

        // Update line series colours
        for (const [segId, rs] of this.lineSeriesMap) {
            const meta = this.lineMetaMap.get(segId)
            const ch = meta?.channel ?? ''
            rs.stroke = this.colourForChannel(ch, tl.line.normal)
        }

        // Update connector annotations
        for (const ann of this.connectorAnnotations) {
            ann.stroke = tl.connector.normal
        }

        // Update instant scatter
        if (this.instantScatterSeries) {
            const marker = this.instantScatterSeries.pointMarker as EllipsePointMarker
            if (marker) {
                marker.fill = tl.line.normal
                marker.stroke = tl.line.normal
            }
        }
    }

    setScheduleData(structure: StructureNode, segments: TimelineSegment[], maxPaths?: number): LineLayoutResult {
        this.clearAll()
        if (segments.length === 0) {
            this.layoutResult = { lines: [], instants: [], connectors: [], pathYCentres: new Map(), pathYRanges: new Map() }
            return this.layoutResult
        }

        this.layoutResult = layoutLines(structure, segments, 0, 1, maxPaths)
        const { lines, instants, connectors } = this.layoutResult

        const yAxis = this.surface.yAxes.get(0)
        if (yAxis) {
            yAxis.visibleRange = new NumberRange(0, 1)
            yAxis.visibleRangeLimit = new NumberRange(0, 1)
        }

        // Build per-channel colour map
        const channels = [...new Set(segments.map(s => s.channel).filter(c => c !== ''))]
        this.channelColourMap = buildChannelColourMap(channels, this.theme.timeline.rect.colour)

        // Render branch connectors first (behind lines)
        this.renderConnectors(connectors)

        // Render duration lines
        for (const line of lines) {
            this.addLineSeries(line)
        }

        // Render instant markers as a single scatter series
        this.renderInstants(instants)

        log.debug(`Rendered: ${lines.length} lines, ${instants.length} instants, ${connectors.length} connectors`)
        return this.layoutResult
    }

    /** Gene filter is a no-op for the timeline. */
    override highlightGene(_gene: string | null): void {}

    /**
     * Dim all line segments except those whose executionPath matches `path`.
     * Pass null to restore all to normal opacity.
     */
    override highlightPath(path: string | null): void {
        for (const [segId, rs] of this.lineSeriesMap) {
            const meta = this.lineMetaMap.get(segId)
            const matches = path === null || meta?.executionPath === path
            rs.opacity = matches ? 1 : PATH_DIM_OPACITY
            rs.strokeThickness = matches && path !== null ? LINE_THICKNESS_HOVER : LINE_THICKNESS
        }
        // Dim connector annotations
        for (let i = 0; i < this.connectorAnnotations.length; i++) {
            const conn = this.connectorMeta[i]!
            const matches = path === null || conn.childPaths.includes(path)
            this.connectorAnnotations[i]!.opacity = matches ? 1 : PATH_DIM_OPACITY
        }
        // Dim instant scatter (whole series — individual opacity not supported)
        if (this.instantScatterSeries) {
            const anyMatch = path === null || this.instantIndexMap.some(inst => inst.executionPath === path)
            this.instantScatterSeries.opacity = anyMatch ? 1 : PATH_DIM_OPACITY
        }
    }

    override setTimeExtent(minTime: number, maxTime: number): void {
        super.setTimeExtent(minTime, maxTime)
    }

    // Compat stubs for MainChart
    deselectSegment(): void {}
    get hasSegmentSelection(): boolean { return false }

    /** Access the layout result for external consumers (e.g., pathYRanges). */
    getLayoutResult(): LineLayoutResult | null {
        return this.layoutResult
    }

    // ── Line rendering ──────────────────────────────────────────────────

    private addLineSeries(line: LayoutLine): void {
        const dataSeries = new XyDataSeries(this.wasmContext, {
            dataSeriesName: `line:${line.segmentId}`,
            isSorted: true,
            containsNaN: false,
        })
        dataSeries.appendRange([line.x1, line.x2], [line.y, line.y])

        const colour = this.colourForChannel(line.channel, this.theme.timeline.line.normal)

        const lineSeries = new FastLineRenderableSeries(this.wasmContext, {
            dataSeries,
            stroke: colour,
            strokeThickness: LINE_THICKNESS,
            onHoveredChanged: (source) => {
                const hovered = source.isHovered
                const rs = source as FastLineRenderableSeries
                const currentColour = this.colourForChannel(line.channel, this.theme.timeline.line.normal)
                rs.stroke = hovered ? this.theme.timeline.line.hover : currentColour
                rs.strokeThickness = hovered ? LINE_THICKNESS_HOVER : LINE_THICKNESS

                if (hovered) {
                    const tooltipText = line.label
                        ? `${line.label}\npath: ${line.executionPath}\n${formatTime(line.x1)} - ${formatTime(line.x2)}`
                        : `${line.executionPath}\n${formatTime(line.x1)} - ${formatTime(line.x2)}`
                    this.showTooltipAt(tooltipText)
                } else {
                    this.hideTooltipDiv()
                }

                this.handleHover(hovered, line.modelPath, line.executionPath)
            },
        })

        this.surface.renderableSeries.add(lineSeries)
        this.lineSeriesMap.set(line.segmentId, lineSeries)
        this.lineMetaMap.set(line.segmentId, line)
    }

    // ── Instant markers ─────────────────────────────────────────────────

    private renderInstants(instants: LayoutInstant[]): void {
        if (instants.length === 0) return

        // Group instants that share the same (x, y) to avoid overlapping dots
        const grouped = this.groupInstantsByPosition(instants)
        const xValues: number[] = []
        const yValues: number[] = []
        this.instantIndexMap = []

        for (const group of grouped) {
            xValues.push(group[0]!.x)
            yValues.push(group[0]!.y)
            // Store the first instant of the group for hit-testing; others accessible via tooltip
            this.instantIndexMap.push(group[0]!)
        }

        const dataSeries = new XyDataSeries(this.wasmContext, {
            dataSeriesName: '__instants',
            containsNaN: false,
        })
        dataSeries.appendRange(xValues, yValues)

        this.instantScatterSeries = new XyScatterRenderableSeries(this.wasmContext, {
            dataSeries,
            pointMarker: new EllipsePointMarker(this.wasmContext, {
                width: INSTANT_MARKER_RADIUS * 2,
                height: INSTANT_MARKER_RADIUS * 2,
                fill: this.theme.timeline.line.normal,
                stroke: this.theme.timeline.line.normal,
                strokeThickness: 1,
            }),
            onHoveredChanged: (source) => {
                const hovered = source.isHovered
                const marker = (source as XyScatterRenderableSeries).pointMarker as EllipsePointMarker
                if (marker) {
                    const size = hovered ? INSTANT_MARKER_RADIUS_HOVER * 2 : INSTANT_MARKER_RADIUS * 2
                    marker.width = size
                    marker.height = size
                    marker.fill = hovered ? this.theme.timeline.line.hover : this.theme.timeline.line.normal
                    marker.stroke = hovered ? this.theme.timeline.line.hover : this.theme.timeline.line.normal
                }

                if (hovered) {
                    // Find nearest instant to mouse
                    const nearest = this.findNearestInstant()
                    if (nearest) {
                        const group = this.getInstantGroup(nearest)
                        const tooltipText = group.map(inst =>
                            inst.label
                                ? `${inst.label} (${inst.executionPath})`
                                : inst.executionPath
                        ).join('\n') + `\nt=${formatTime(nearest.x)}`
                        this.showTooltipAt(tooltipText)
                        this.instantHoverChangeCallback?.(nearest.modelPath)
                    }
                } else {
                    this.hideTooltipDiv()
                    this.instantHoverChangeCallback?.(null)
                }
            },
        })

        this.surface.renderableSeries.add(this.instantScatterSeries)
    }

    /** Group instants sharing the same (x, executionPath) position. */
    private groupInstantsByPosition(instants: LayoutInstant[]): LayoutInstant[][] {
        const map = new Map<string, LayoutInstant[]>()
        for (const inst of instants) {
            const key = `${inst.x}:${inst.y}`
            const list = map.get(key)
            if (list) list.push(inst)
            else map.set(key, [inst])
        }
        return [...map.values()]
    }

    /** Find the instant nearest to current mouse position. */
    private findNearestInstant(): LayoutInstant | null {
        if (this.instantIndexMap.length === 0) return null
        // Use x-axis coordinate from mouse position
        const xAxis = this.surface.xAxes.get(0)
        if (!xAxis) return this.instantIndexMap[0]!

        const rect = this.parentSurface.domCanvas2D.getBoundingClientRect()
        const mouseXPx = this.lastMouseClient.x - rect.left
        const mouseXData = xAxis.getCurrentCoordinateCalculator().getDataValue(mouseXPx)

        let nearest = this.instantIndexMap[0]!
        let minDist = Math.abs(nearest.x - mouseXData)
        for (let i = 1; i < this.instantIndexMap.length; i++) {
            const inst = this.instantIndexMap[i]!
            const dist = Math.abs(inst.x - mouseXData)
            if (dist < minDist) {
                minDist = dist
                nearest = inst
            }
        }
        return nearest
    }

    /** Get all instants at the same position as the given one. */
    private getInstantGroup(target: LayoutInstant): LayoutInstant[] {
        return this.instantIndexMap.filter(inst => inst.x === target.x && inst.y === target.y)
    }

    // ── Branch connectors ───────────────────────────────────────────────

    private renderConnectors(connectors: LayoutBranchConnector[]): void {
        this.connectorMeta = connectors
        for (const conn of connectors) {
            const line = new LineAnnotation({
                x1: conn.x, x2: conn.x,
                y1: conn.yMin, y2: conn.yMax,
                stroke: this.theme.timeline.connector.normal,
                strokeThickness: CONNECTOR_THICKNESS,
            })
            this.addDataAnnotation(line)
            this.connectorAnnotations.push(line)
        }
    }

    // ── Hover handling ──────────────────────────────────────────────────

    private handleHover(hovered: boolean, modelPath: string, executionPath: string): void {
        if (hovered) {
            this.currentHoveredExecution = executionPath
            this.hoverChangeCallback?.(modelPath, executionPath)
        } else if (this.currentHoveredExecution === executionPath) {
            this.currentHoveredExecution = null
            this.hoverChangeCallback?.(null, null)
        }
    }

    // ── Tooltip ─────────────────────────────────────────────────────────

    private showTooltipAt(text: string): void {
        if (!this.tooltipDiv) {
            this.tooltipDiv = this.createTooltipDiv()
        }
        this.tooltipDiv.textContent = text
        this.tooltipDiv.style.left = `${this.lastMouseClient.x + 12}px`
        this.tooltipDiv.style.top = `${this.lastMouseClient.y - 20}px`
        this.tooltipDiv.style.display = 'block'
    }

    private hideTooltipDiv(): void {
        if (this.tooltipDiv) this.tooltipDiv.style.display = 'none'
    }

    private createTooltipDiv(): HTMLDivElement {
        const el = document.createElement('div')
        el.className = 'grs-tooltip'
        Object.assign(el.style, {
            position: 'fixed',
            display: 'none',
            pointerEvents: 'none',
            zIndex: '9999',
        })
        document.body.appendChild(el)
        return el
    }

    // ── Colour helpers ──────────────────────────────────────────────────

    private colourForChannel(channel: string, fallback: string): string {
        if (channel === '') return fallback
        return this.channelColourMap.get(channel) ?? fallback
    }

    // ── Visibility ──────────────────────────────────────────────────────

    private setAnnotationsVisible(visible: boolean): void {
        setSvgAnnotationsVisible(this.dataAnnotations, visible)
        if (!visible) this.hideTooltipDiv()
        for (const rs of this.surface.renderableSeries.asArray()) {
            rs.opacity = visible ? 1 : 0
        }
    }

    // ── Annotation lifecycle ────────────────────────────────────────────

    private addDataAnnotation(ann: AnnotationBase): void {
        this.surface.annotations.add(ann)
        this.dataAnnotations.add(ann)
    }

    private clearAll(): void {
        // Clear annotations
        for (const ann of this.dataAnnotations) {
            this.surface.annotations.remove(ann)
            ann.delete()
        }
        this.dataAnnotations.clear()
        this.connectorAnnotations = []
        this.connectorMeta = []

        // Clear series
        this.surface.renderableSeries.clear()
        this.lineSeriesMap.clear()
        this.lineMetaMap.clear()
        this.instantMetaMap.clear()
        this.instantScatterSeries = null
        this.instantIndexMap = []

        if (this.tooltipDiv) this.tooltipDiv.style.display = 'none'
    }
}
