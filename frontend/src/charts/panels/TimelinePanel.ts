import {
    AnnotationHoverModifier,
    EAxisAlignment,
    EColumnMode, EColumnYMode, EHorizontalAnchorPoint, EHoverMode, EVerticalAnchorPoint,
    FastRectangleRenderableSeries, LineAnnotation, NumericAxis,
    NumberRange, TextAnnotation, Thickness, XyxyDataSeries,
    type AnnotationBase
} from "scichart"
import { BasePanel, PATH_DIM_OPACITY, type BasePanelOptions } from "./BasePanel"
import { layoutRectangles, type LayoutRectangle } from "../layout/rectangleLayout"
import type { StructureNode, TimelineSegment } from "@/types/schedule"
import { setSvgAnnotationsVisible } from "../svgAnnotationVisibility"
import { withOpacity, buildChannelColourMap } from "@/utils/colorUtils"
import { CHART_FONT_SIZES, AXIS_THICKNESS } from "../chartConstants"
import { setupTimeAxis, formatTime } from "../timeFormat"
import { DragGuardModifier } from "../modifiers/DragGuardModifier"

/** Minimum pixel width/height below which a rectangle label is hidden. */
const MIN_LABEL_PX_WIDTH = 80
const MIN_LABEL_PX_HEIGHT = 2
/** Horizontal padding subtracted from rect pixel width before text-fit comparison. */
const LABEL_TEXT_PADDING_PX = 150

/** Offscreen canvas used for measuring label text widths. */
const _measureCtx = document.createElement('canvas').getContext('2d')!

/** Instant model line thickness (normal / hovered). */
const INSTANT_LINE_THICKNESS = 4.0
const INSTANT_LINE_THICKNESS_HOVER = 4.0

/** Pixel offset shifting the instant label box right of its line. */
const INSTANT_LABEL_X_SHIFT = 1

/** Rectangle segment fill opacities (mode-independent). */
const RECT_FILL_OPACITY = 0.6
const RECT_FILL_OPACITY_HOVER = 0.8

/** Rectangle segment styling. */
const RECT_STROKE_THICKNESS = 2.0

/** Rectangle label font size bounds and scaling. */
const LABEL_FONT_SIZE_MIN = 6
const LABEL_FONT_SIZE_MAX = 10
const LABEL_FONT_SIZE_MULTIPLIER = 0.35

/** Instant label font size bounds and scaling. */
const INSTANT_FONT_SIZE_MIN = 6
const INSTANT_FONT_SIZE_MAX = 9
const INSTANT_FONT_SIZE_MULTIPLIER = 0.03

/** Minimum pixel height per instant slice before labels are merged. */
const MIN_INSTANT_SLICE_PX = 20

export type SegmentClickCallback = (segmentId: number, modelPath: string) => void
export type HoverChangeCallback = (modelPath: string | null, executionPath: string | null) => void

export class TimelinePanel extends BasePanel {
    private segmentClickCallback?: SegmentClickCallback
    private hoverChangeCallback?: HoverChangeCallback
    private instantHoverChangeCallback?: (path: string | null) => void
    private drillInCallback?: (executionPath: string) => void
    /** Track data annotations so we can clear only them (not modifier-owned ones). */
    private dataAnnotations = new Set<AnnotationBase>()
    /** Currently selected segment ID (null = none). */
    private selectedSegmentId: number | null = null
    /** Full time extent for zoom-to-fit on deselect. */
    private fullTimeExtent: { min: number; max: number } | null = null
    /** Visible range captured just before selection zoom — restored on deselect. */
    private preSelectionTimeRange: { min: number; max: number } | null = null
    /** Stored rectangles for selection lookup. */
    private rectangles: LayoutRectangle[] = []
    /** Currently hovered execution path (guards against stale unhover events). */
    private currentHoveredExecution: string | null = null
    /** Drag guard modifier for click-vs-drag discrimination. */
    private dragGuard: DragGuardModifier | null = null
    /** DOM tooltip for instant label hover (consistent with network viewer tooltip style). */
    private tooltipDiv: HTMLDivElement | null = null
    /** Last known mouse client coordinates, updated on canvas mousemove. */
    private lastMouseClient: { x: number; y: number } = { x: 0, y: 0 }
    private readonly onMouseMove = (e: MouseEvent) => { this.lastMouseClient = { x: e.clientX, y: e.clientY } }
    private readonly onDblClick = () => {
        if (this.currentHoveredExecution && this.drillInCallback) {
            this.drillInCallback(this.currentHoveredExecution)
        }
    }
    /** Map from rectangle label annotation to its source rectangle (for adaptive visibility). */
    private labelRectMap = new Map<TextAnnotation, LayoutRectangle>()
    /** Map from segmentId to its label annotation (for hover/select colour updates). */
    private segmentLabelMap = new Map<number, TextAnnotation>()
    /** Map from instant label annotation to its slice height in data coords. */
    private instantLabelSliceMap = new Map<TextAnnotation, number>()
    /** Per-channel fill colours (theme-aware; rebuilt on data load and theme switch). */
    private channelColourMap = new Map<string, string>()
    /** Map from segmentId to its channel (for hover/theme colour lookup). */
    private segmentChannelMap = new Map<number, string>()

    /** Currently selected FastRectangleRenderableSeries. */
    private selectedRectSeries: FastRectangleRenderableSeries | null = null
    private readonly onParentResized = () => requestAnimationFrame(() => this.updateLabelSizes())
    /** True while an instant label is hovered — suppresses rect hover to prevent jitter. */
    private isHoveringInstant = false

    constructor(options: BasePanelOptions) {
        super(options)

        this.dragGuard = this.surface.chartModifiers.asArray()
            .find(m => m instanceof DragGuardModifier) as DragGuardModifier ?? null

        this.surface.chartModifiers.add(new AnnotationHoverModifier({
            enableHover: true,
            hoverMode: EHoverMode.AbsoluteTopmost,
            notifyOutEvent: true,
            notifyPositionUpdate: true,
        }))

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

        xAxis.visibleRangeChanged.subscribe(() => this.updateLabelSizes())
        this.parentSurface.resized.subscribe(this.onParentResized)
        this.parentSurface.domCanvas2D.addEventListener('mousemove', this.onMouseMove)
        this.parentSurface.domCanvas2D.addEventListener('dblclick', this.onDblClick)
    }

    onSegmentClick(callback: SegmentClickCallback): void {
        this.segmentClickCallback = callback
    }

    onHoverChange(callback: HoverChangeCallback): void {
        this.hoverChangeCallback = callback
    }

    onInstantHoverChange(callback: (path: string | null) => void): void {
        this.instantHoverChangeCallback = callback
    }

    /** Register a callback for double-click drill-in on a timeline rectangle. */
    onDrillIn(callback: (executionPath: string) => void): void {
        this.drillInCallback = callback
    }

    override dispose(): void {
        this.parentSurface.resized.unsubscribe(this.onParentResized)
        this.parentSurface.domCanvas2D.removeEventListener('mousemove', this.onMouseMove)
        this.parentSurface.domCanvas2D.removeEventListener('dblclick', this.onDblClick)
        this.tooltipDiv?.remove()
        super.dispose()
    }

    override get isVisible(): boolean {
        return super.isVisible
    }

    /** Hide/show all data annotations when the panel visibility toggles. */
    override set isVisible(value: boolean) {
        super.isVisible = value
        this.setAnnotationsVisible(value)
    }

    /** Re-apply theme colours to all annotations, series strokes, and tooltip. */
    override applyTheme(isDark: boolean): void {
        super.applyTheme(isDark)
        const tl = this.theme.timeline
        for (const ann of this.dataAnnotations) {
            if (ann instanceof LineAnnotation) {
                ann.stroke = tl.instant.normal.line
            } else if (ann instanceof TextAnnotation) {
                if (ann.background) {
                    ann.textColor = tl.instant.normal.text
                    ann.background = tl.instant.normal.bg
                } else {
                    ann.textColor = this.theme.text.muted
                }
            }
        }
        // Rebuild channel colour map with new theme base colour
        const channels = [...this.channelColourMap.keys()].filter(c => c !== '')
        this.channelColourMap = buildChannelColourMap(channels, tl.rect.colour)

        for (const rs of this.surface.renderableSeries.asArray()) {
            if (rs instanceof FastRectangleRenderableSeries) {
                if (rs === this.selectedRectSeries) {
                    rs.fill = withOpacity(tl.rect.selected.fill, RECT_FILL_OPACITY_HOVER)
                    rs.stroke = tl.rect.selected.stroke
                } else {
                    const name = rs.dataSeries?.dataSeriesName ?? ''
                    const segId = name.startsWith('segment:') ? parseInt(name.substring(8), 10) : -1
                    const ch = this.segmentChannelMap.get(segId) ?? ''
                    rs.fill = withOpacity(this.colourForChannel(ch), RECT_FILL_OPACITY)
                    rs.stroke = tl.rect.normal.stroke
                }
            }
        }
    }

    setScheduleData(structure: StructureNode, segments: TimelineSegment[], maxPaths?: number): LayoutRectangle[] {
        this.clearOwnAnnotations()
        if (this.tooltipDiv) this.tooltipDiv.style.display = 'none'
        this.labelRectMap.clear()
        this.instantLabelSliceMap.clear()
        this.segmentLabelMap.clear()
        this.segmentChannelMap.clear()
        this.surface.renderableSeries.clear()
        this.restoreSelectedSeries()
        this.selectedSegmentId = null
        if (segments.length === 0) { this.rectangles = []; return [] }

        this.rectangles = layoutRectangles(structure, segments, 0, 1, maxPaths)

        const yAxis = this.surface.yAxes.get(0)
        if (yAxis) {
            yAxis.visibleRange = new NumberRange(0, 1)
            yAxis.visibleRangeLimit = new NumberRange(0, 1)
        }

        // Build per-channel colour map
        const channels = [...new Set(segments.map(s => s.channel).filter(c => c !== ''))]
        this.channelColourMap = buildChannelColourMap(channels, this.theme.timeline.rect.colour)

        // Populate segment-to-channel lookup
        for (const seg of segments) {
            this.segmentChannelMap.set(seg.id, seg.channel)
        }

        const instantsByXAndBand = groupInstantsByXAndBand(this.rectangles)

        for (const rect of this.rectangles) {
            if (!rect.isInstant) {
                this.addRectangleSeries(rect)
            }
        }

        for (const [, instants] of instantsByXAndBand) {
            this.addInstantGroup(instants)
        }

        return this.rectangles
    }

    /**
     * Gene filter is a no-op for the timeline (segments are path-based, not gene-based).
     */
    override highlightGene(_gene: string | null): void {
        // Timeline segments have no gene concept — intentional no-op.
    }

    /**
     * Dim all rectangle segments except those whose executionPath matches `path`.
     * Pass null to restore all to normal opacity.
     */
    override highlightPath(path: string | null): void {
        for (const rs of this.surface.renderableSeries.asArray()) {
            if (!(rs instanceof FastRectangleRenderableSeries)) continue
            const name = rs.dataSeries?.dataSeriesName ?? ''
            if (!name.startsWith('segment:')) continue
            const segId = parseInt(name.substring(8), 10)
            // Don't touch the currently selected segment
            if (segId === this.selectedSegmentId) continue

            const rect = this.rectangles.find(r => r.segmentId === segId)
            const matches = path === null || rect?.executionPath === path
            rs.opacity = matches ? 1 : PATH_DIM_OPACITY
            const lbl = this.segmentLabelMap.get(segId)
            if (lbl) lbl.opacity = matches ? 1 : PATH_DIM_OPACITY
        }
    }

    /** Store full time extent so deselect can zoom back. */
    override setTimeExtent(minTime: number, maxTime: number): void {
        super.setTimeExtent(minTime, maxTime)
        this.fullTimeExtent = { min: minTime, max: maxTime }
    }

    /** Deselect current segment and restore the zoom state that was active before selection. */
    deselectSegment(): void {
        if (this.selectedSegmentId === null) return
        this.restoreSelectedSeries()
        this.selectedSegmentId = null
        const range = this.preSelectionTimeRange ?? this.fullTimeExtent
        if (range) this.setVisibleTimeRange(range.min, range.max)
        this.preSelectionTimeRange = null
        this.segmentClickCallback?.(-1, '')
    }

    /** Whether a segment is currently selected. */
    get hasSegmentSelection(): boolean {
        return this.selectedSegmentId !== null
    }

    /** Look up the fill colour for a given channel (falls back to theme base). */
    private colourForChannel(channel: string): string {
        return this.channelColourMap.get(channel) ?? this.theme.timeline.rect.colour
    }

    // ── Rectangle segments ──────────────────────────────────────────────

    private addRectangleSeries(rect: LayoutRectangle): void {
        const dataSeries = new XyxyDataSeries(this.wasmContext, {
            dataSeriesName: `segment:${rect.segmentId}`,
            isSorted: true,
            containsNaN: false
        })
        dataSeries.appendRange([rect.x1], [rect.y1], [rect.x2], [rect.y2])

        const { segmentId, modelPath, executionPath, channel } = rect

        const colour = this.colourForChannel(channel)
        const rectSeries = new FastRectangleRenderableSeries(this.wasmContext, {
            dataSeries,
            stroke: this.theme.timeline.rect.normal.stroke,
            fill: withOpacity(colour, RECT_FILL_OPACITY),
            strokeThickness: RECT_STROKE_THICKNESS,
            columnXMode: EColumnMode.StartEnd,
            columnYMode: EColumnYMode.TopBottom,
            onHoveredChanged: (source) => {
                const hovered = source.isHovered
                const rs = source as FastRectangleRenderableSeries
                // Don't override selection colours on hover
                if (this.selectedSegmentId !== segmentId) {
                    const currentColour = this.colourForChannel(channel)
                    rs.fill = withOpacity(currentColour, hovered ? RECT_FILL_OPACITY_HOVER : RECT_FILL_OPACITY)
                    rs.stroke = hovered ? this.theme.timeline.rect.hover.stroke : this.theme.timeline.rect.normal.stroke
                    const lbl = this.segmentLabelMap.get(segmentId)
                    if (lbl) lbl.textColor = hovered ? this.theme.timeline.rect.hover.text : this.theme.timeline.rect.normal.text
                }
                // When entering a new rect, always propagate even if an instant
                // is still hovered (instant unhover fires after rect hover).
                // Only suppress unhover events while an instant is active.
                if (this.isHoveringInstant && !hovered) return
                if (this.isHoveringInstant && hovered) this.isHoveringInstant = false
                this.handleHover(hovered, modelPath, executionPath)
            },
            onSelectedChanged: (source) => {
                if (!source.isSelected) return
                // Ignore selection triggered by drag-release
                if (this.dragGuard?.isDrag) {
                    source.isSelected = false
                    return
                }
                source.isSelected = false
                // Toggle: click same segment again -> deselect
                if (this.selectedSegmentId === segmentId) {
                    this.restoreSelectedSeries()
                    this.deselectSegment()
                    return
                }
                // Deselect previous, then highlight new
                this.restoreSelectedSeries()
                const rs = source as FastRectangleRenderableSeries
                this.selectedRectSeries = rs
                rs.fill = withOpacity(this.theme.timeline.rect.selected.fill, RECT_FILL_OPACITY_HOVER)
                rs.stroke = this.theme.timeline.rect.selected.stroke
                rs.strokeThickness = RECT_STROKE_THICKNESS * 1.5
                const lbl = this.segmentLabelMap.get(segmentId)
                if (lbl) lbl.textColor = this.theme.timeline.rect.selected.text

                const xRange = this.surface.xAxes.get(0)?.visibleRange
                this.preSelectionTimeRange = xRange ? { min: xRange.min, max: xRange.max } : null
                this.selectedSegmentId = segmentId
                this.zoomToSegment(rect)
                this.segmentClickCallback?.(segmentId, modelPath)
            }
        })

        this.surface.renderableSeries.add(rectSeries)
        this.addRectangleLabel(rect)
    }

    /** Label inside a rectangle segment. Hidden dynamically if it doesn't fit. */
    private addRectangleLabel(rect: LayoutRectangle): void {
        const midX = (rect.x1 + rect.x2) / 2
        const midY = (rect.y1 + rect.y2) / 2
        const fontSize = this.computeLabelFontSize(rect)

        const label = new TextAnnotation({
            x1: midX,
            y1: midY,
            text: this.rectLabelFitsFullText(rect, fontSize) ? this.rectFullLabelText(rect) : rect.executionPath,
            fontSize,
            textColor: this.theme.timeline.rect.normal.text,
            horizontalAnchorPoint: EHorizontalAnchorPoint.Center,
            verticalAnchorPoint: EVerticalAnchorPoint.Center,
            isHidden: !this.labelFits(rect)
        })
        this.addDataAnnotation(label)
        this.labelRectMap.set(label, rect)
        this.segmentLabelMap.set(rect.segmentId, label)
    }

    // ── Instant model groups ────────────────────────────────────────────

    /** Render a group of instant model annotations sharing the same x and y-band. */
    private addInstantGroup(instants: LayoutRectangle[]): void {
        const x = instants[0]!.x1
        const yMin = instants[0]!.y1
        const yMax = instants[0]!.y2

        const line = new LineAnnotation({
            x1: x, x2: x, y1: yMin, y2: yMax,
            stroke: this.theme.timeline.instant.normal.line,
            strokeThickness: INSTANT_LINE_THICKNESS,
        })
        this.addDataAnnotation(line)

        // Divide vertical space equally among labels
        const n = instants.length
        const sliceHeight = (yMax - yMin) / n
        const slicePx = sliceHeight * this.subchartHeightPx()

        if (n > 1 && slicePx < MIN_INSTANT_SLICE_PX) {
            this.addMergedInstantLabel(instants, line, x, (yMin + yMax) / 2, yMax - yMin)
        } else {
            instants.forEach((rect, i) => {
                const sliceTop = yMax - i * sliceHeight
                const sliceBottom = sliceTop - sliceHeight
                const sliceMidY = (sliceTop + sliceBottom) / 2

                this.addInstantLabel(rect, line, x, sliceMidY, sliceHeight)
            })
        }
    }

    /** Merged label for a group of instants that don't fit individually. */
    private addMergedInstantLabel(
        instants: LayoutRectangle[],
        line: LineAnnotation,
        x: number,
        yCenter: number,
        bandHeight: number,
    ): void {
        const perModel = instants.map(r => {
            const name = r.label ?? r.executionPath
            return `${name}\npath=${r.executionPath}`
        })
        const inlineText = `${instants.length} models`
        const tooltipText = perModel.join('\n---\n') + `\nt=${formatTime(x)}`
        const fontSize = this.computeInstantFontSize(bandHeight)

        const text = new TextAnnotation({
            x1: x,
            y1: yCenter,
            text: inlineText,
            fontSize,
            textColor: this.theme.timeline.instant.normal.text,
            background: this.theme.timeline.instant.normal.bg,
            horizontalAnchorPoint: EHorizontalAnchorPoint.Left,
            verticalAnchorPoint: EVerticalAnchorPoint.Center,
            xCoordShift: INSTANT_LABEL_X_SHIFT,
            padding: new Thickness(3, 6, 3, 9),
            onHover: (args) => {
                const hovered = args.isHovered
                this.surface.suspendUpdates()
                line.stroke = hovered ? this.theme.timeline.instant.hover.line : this.theme.timeline.instant.normal.line
                line.strokeThickness = hovered ? INSTANT_LINE_THICKNESS_HOVER : INSTANT_LINE_THICKNESS
                text.background = hovered ? this.theme.timeline.instant.hover.bg : this.theme.timeline.instant.normal.bg
                text.textColor = hovered ? this.theme.timeline.instant.hover.text : this.theme.timeline.instant.normal.text
                if (hovered) {
                    this.showTooltipAt(tooltipText)
                } else {
                    this.hideTooltipDiv()
                }
                this.surface.resumeUpdates()
                this.isHoveringInstant = hovered
            },
        })
        this.addDataAnnotation(text)
        this.instantLabelSliceMap.set(text, bandHeight)
    }

    /** Single instant label: a TextAnnotation with background fill and hover highlight. */
    private addInstantLabel(
        rect: LayoutRectangle,
        line: LineAnnotation,
        x: number,
        yCenter: number,
        sliceHeight: number
    ): void {
        const { modelPath, executionPath, label } = rect
        const tooltipText = label 
            ? `${label}\nt=${formatTime(x)}\npath=${executionPath}`
            : `t=${formatTime(x)}\npath=${executionPath}`
        // Inline label: first line of label (type name), fallback to execution path
        const inlineText = label ? label.split('\n')[0]! : executionPath
        const fontSize = this.computeInstantFontSize(sliceHeight)

        const text = new TextAnnotation({
            x1: x,
            y1: yCenter,
            text: inlineText,
            fontSize,
            textColor: this.theme.timeline.instant.normal.text,
            background: this.theme.timeline.instant.normal.bg,
            horizontalAnchorPoint: EHorizontalAnchorPoint.Left,
            verticalAnchorPoint: EVerticalAnchorPoint.Center,
            xCoordShift: INSTANT_LABEL_X_SHIFT,
            padding: new Thickness(3, 6, 3, 9),
            onHover: (args) => {
                const hovered = args.isHovered
                // Batch all property mutations to prevent rendering artefacts
                this.surface.suspendUpdates()
                line.stroke = hovered ? this.theme.timeline.instant.hover.line : this.theme.timeline.instant.normal.line
                line.strokeThickness = hovered ? INSTANT_LINE_THICKNESS_HOVER : INSTANT_LINE_THICKNESS
                text.background = hovered ? this.theme.timeline.instant.hover.bg : this.theme.timeline.instant.normal.bg
                text.textColor = hovered ? this.theme.timeline.instant.hover.text : this.theme.timeline.instant.normal.text
                if (hovered) {
                    this.showTooltipAt(tooltipText)
                } else {
                    this.hideTooltipDiv()
                }
                this.surface.resumeUpdates()
                this.isHoveringInstant = hovered
                this.instantHoverChangeCallback?.(hovered ? modelPath : null)
            },
        })
        this.addDataAnnotation(text)
        this.instantLabelSliceMap.set(text, sliceHeight)
    }

    // ── Hover handling ──────────────────────────────────────────────────

    /** Unified hover handler for both rectangles and instant labels. */
    private handleHover(hovered: boolean, modelPath: string, executionPath: string): void {
        if (hovered) {
            this.currentHoveredExecution = executionPath
            this.hoverChangeCallback?.(modelPath, executionPath)
        } else if (this.currentHoveredExecution === executionPath) {
            // Only clear if WE are the one being unhovered — prevents a late
            // unhover from rectangle A cancelling the hover on rectangle B
            // when the mouse moves directly between them.
            this.currentHoveredExecution = null
            this.hoverChangeCallback?.(null, null)
        }
    }

    // ── Tooltip DOM div ─────────────────────────────────────────────────

    /** Show the DOM tooltip near the current mouse position. */
    private showTooltipAt(text: string): void {
        if (!this.tooltipDiv) {
            this.tooltipDiv = this.createTooltipDiv()
        }
        this.tooltipDiv.textContent = text
        this.tooltipDiv.style.left = `${this.lastMouseClient.x + 12}px`
        this.tooltipDiv.style.top = `${this.lastMouseClient.y - 20}px`
        this.tooltipDiv.style.display = 'block'
    }

    /** Hide the DOM tooltip. */
    private hideTooltipDiv(): void {
        if (this.tooltipDiv) {
            this.tooltipDiv.style.display = 'none'
        }
    }

    /** Create and append the tooltip div to document.body. */
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

    // ── Selection / Zoom ────────────────────────────────────────────────

    /** Zoom x-axis to fit a segment (with a small margin). */
    private zoomToSegment(rect: LayoutRectangle): void {
        const xAxis = this.surface.xAxes.get(0)
        if (xAxis) {
            xAxis.visibleRange = new NumberRange(rect.x1, rect.x2)
        }
    }

    // ── Label sizing helpers ────────────────────────────────────────────

    /**
     * Recompute font sizes and visibility for all rectangle and instant labels.
     * Triggered by both x-axis zoom and parent surface resize.
     */
    private updateLabelSizes(): void {
        if (!this.isVisible) return
        const h = this.subchartHeightPx()
        if (h === 0) return
        for (const [label, rect] of this.labelRectMap) {
            const fits = this.labelFits(rect)
            label.isHidden = !fits
            if (fits) {
                const fontSize = this.computeLabelFontSize(rect)
                label.fontSize = fontSize
                label.text = this.rectLabelFitsFullText(rect, fontSize)
                    ? this.rectFullLabelText(rect)
                    : rect.executionPath
            }
        }
        for (const [label, sliceHeight] of this.instantLabelSliceMap) {
            label.fontSize = this.computeInstantFontSize(sliceHeight)
        }
    }

    /**
     * Toggle annotations hidden/visible when panel visibility changes.
     * Uses direct SVG DOM manipulation — see svgAnnotationVisibility.ts.
     */
    private setAnnotationsVisible(visible: boolean): void {
        setSvgAnnotationsVisible(this.dataAnnotations, visible)
        if (!visible) this.hideTooltipDiv()
        // Also hide/show renderable series (rectangles) via opacity
        for (const rs of this.surface.renderableSeries.asArray()) {
            rs.opacity = visible ? 1 : 0
        }
    }

    /** Restore the previously selected rectangle to its normal style. */
    private restoreSelectedSeries(): void {
        if (this.selectedRectSeries) {
            const ch = this.selectedSegmentId !== null
                ? (this.segmentChannelMap.get(this.selectedSegmentId) ?? '')
                : ''
            this.selectedRectSeries.fill = withOpacity(this.colourForChannel(ch), RECT_FILL_OPACITY)
            this.selectedRectSeries.stroke = this.theme.timeline.rect.normal.stroke
            this.selectedRectSeries.strokeThickness = RECT_STROKE_THICKNESS
        }
        // Restore label colour on the previously selected segment
        if (this.selectedSegmentId !== null) {
            const lbl = this.segmentLabelMap.get(this.selectedSegmentId)
            if (lbl) lbl.textColor = this.theme.timeline.rect.normal.text
        }
        this.selectedRectSeries = null
    }

    /** Pixel height of this subchart, or 0 if not yet laid out. */
    private subchartHeightPx(): number {
        try { return this.surface.getSubChartRect().height } catch { return 0 }
    }

    /** Pixel width of this subchart, or 0 if not yet laid out. */
    private subchartWidthPx(): number {
        try { return this.surface.getSubChartRect().width } catch { return 0 }
    }

    /** Compute font size relative to the rectangle's estimated pixel height. */
    private computeLabelFontSize(rect: LayoutRectangle): number {
        const yAxis = this.surface.yAxes.get(0)
        if (!yAxis) return LABEL_FONT_SIZE_MIN
        const yRange = yAxis.visibleRange
        const pxPerUnitY = this.subchartHeightPx() / (yRange.max - yRange.min)
        const rectPxHeight = (rect.y2 - rect.y1) * pxPerUnitY
        return Math.round(Math.max(LABEL_FONT_SIZE_MIN, Math.min(LABEL_FONT_SIZE_MAX, rectPxHeight * LABEL_FONT_SIZE_MULTIPLIER)))
    }

    /** Whether a text label fits inside a rectangle at the current zoom. */
    private labelFits(rect: LayoutRectangle): boolean {
        const xAxis = this.surface.xAxes.get(0)
        const yAxis = this.surface.yAxes.get(0)
        if (!xAxis || !yAxis) return true
        const xRange = xAxis.visibleRange
        const yRange = yAxis.visibleRange
        const pxPerUnitX = this.subchartWidthPx() / (xRange.max - xRange.min)
        const pxPerUnitY = this.subchartHeightPx() / (yRange.max - yRange.min)
        const rectPxWidth = (rect.x2 - rect.x1) * pxPerUnitX
        const rectPxHeight = (rect.y2 - rect.y1) * pxPerUnitY
        return rectPxWidth >= MIN_LABEL_PX_WIDTH && rectPxHeight >= MIN_LABEL_PX_HEIGHT
    }

    /** Full label text including model path in brackets. */
    private rectFullLabelText(rect: LayoutRectangle): string {
        return rect.label ? `${rect.label} (${rect.executionPath})` : rect.executionPath
    }

    /**
     * Whether the full label text fits inside the rectangle at current zoom.
     * Uses canvas measureText for an accurate character-width comparison.
     */
    private rectLabelFitsFullText(rect: LayoutRectangle, fontSize: number): boolean {
        const xAxis = this.surface.xAxes.get(0)
        if (!xAxis) return true
        const xRange = xAxis.visibleRange
        const pxPerUnitX = this.subchartWidthPx() / (xRange.max - xRange.min)
        const rectPxWidth = (rect.x2 - rect.x1) * pxPerUnitX
        _measureCtx.font = `${fontSize}px Montserrat, sans-serif`
        const textPx = _measureCtx.measureText(this.rectFullLabelText(rect)).width
        return textPx <= rectPxWidth - LABEL_TEXT_PADDING_PX
    }

    /** Compute font size for instant labels relative to their vertical slice. */
    private computeInstantFontSize(sliceHeight: number): number {
        const slicePx = sliceHeight * this.subchartHeightPx()
        return Math.round(Math.max(INSTANT_FONT_SIZE_MIN, Math.min(INSTANT_FONT_SIZE_MAX, slicePx * INSTANT_FONT_SIZE_MULTIPLIER)))
    }

    // ── Annotation lifecycle ────────────────────────────────────────────

    private addDataAnnotation(ann: AnnotationBase): void {
        this.surface.annotations.add(ann)
        this.dataAnnotations.add(ann)
    }

    private clearOwnAnnotations(): void {
        for (const ann of this.dataAnnotations) {
            this.surface.annotations.remove(ann)
            ann.delete()
        }
        this.dataAnnotations.clear()
    }
}

// ── Pure helpers ─────────────────────────────────────────────────────────

/** Group instants by (x, y-band) so branches get separate lines. */
function groupInstantsByXAndBand(rectangles: LayoutRectangle[]): Map<string, LayoutRectangle[]> {
    const map = new Map<string, LayoutRectangle[]>()
    for (const rect of rectangles) {
        if (!rect.isInstant) continue
        const key = `${rect.x1}:${rect.y1}:${rect.y2}`
        const list = map.get(key)
        if (list) { list.push(rect) }
        else { map.set(key, [rect]) }
    }
    return map
}