import { EXyDirection, MouseWheelZoomModifier, SciChartSurface, ZoomExtentsModifier, ZoomPanModifier, SeriesSelectionModifier, type TSciChart } from "scichart"
import { toBlob } from 'html-to-image'
import { saveFile } from '@/utils/saveFile'
import { compositCanvasesToBlob } from '@/utils/canvasExport'
import { isTauri } from '@/config/api'
import { AxisSyncModifier } from "./modifiers/AxisSyncModifier"
import { DragGuardModifier } from "./modifiers/DragGuardModifier"
import { SelectSyncModifier, type GroupingFn } from "./modifiers/SelectSyncModifier"
import type { BasePanel, BasePanelOptions } from "./panels/BasePanel"
import type { TimeseriesPanel } from "./panels/TimeseriesPanel"
import type { Ref } from "vue"
import { getTheme } from "@/config/theme"
import { CountsPanel } from "./panels/CountsPanel"
import { PhaseSpacePanel, type HoverInfo } from "./panels/PhaseSpacePanel"
import { SharedTimeCursorModifier } from "./modifiers/SharedTimeCursorModifier"
import { PanelGroup } from "./layout/PanelGroup"
import { ChartLayout, type GroupNode, type LayoutNode } from "./layout/ChartLayout"
import { getPathTimeRanges } from "@/types/schedule"
import type { TimelineSegment, TimeseriesData, TimeseriesMetadata } from "@/types"
import type { PhaseSpaceResult } from "@/types/simulation"
import { type SpeciesType } from "@/types/schedule"
import { useScheduleStore } from "@/stores/scheduleStore"

/** Visible time window + pixel width driving adaptive (pyramid) data requests. */
export interface Viewport {
    t0: number
    t1: number
    widthPx: number
}

export type SelectionChangeCallback = (selectedGenes: string[]) => void

/** Fraction of width allocated to the timeseries group when phase space is visible. */
const TIMESERIES_SPLIT_RATIO = 0.65

export class MainChart {
    private surface!: SciChartSurface
    private wasmContext!: TSciChart

    // -- Panel groups & layout --
    private timeseriesGroup!: PanelGroup
    private phaseSpaceGroup!: PanelGroup
    private chartLayout!: ChartLayout
    private timeseriesLayoutNode!: GroupNode

    // -- Scoped modifiers (timeseries group) --
    private axisSynchroniser!: AxisSyncModifier
    private selectSyncModifier!: SelectSyncModifier
    private timeCursorModifier!: SharedTimeCursorModifier

    // -- Tracks (convenience array parallelling timeseriesGroup) --
    private tracks!: Array<{ id: string; panel: BasePanel }>

    // -- Phase space --
    private phaseSpacePanel: PhaseSpacePanel | null = null

    // -- Callbacks --
    private timepointChangeCallback?: (timepoint: number) => void
    private selectionChangeCallback?: SelectionChangeCallback
    private phaseSpacePathSelectCallback?: (path: string) => void
    private phaseSpaceHoverCallback?: (info: HoverInfo | null) => void
    private timeseriesPathHoverCallback?: (path: string | null) => void
    private timeseriesPathSelectCallback?: (path: string) => void
    private timeseriesGeneHoverCallback?: (gene: string | null) => void

    private isDark = false

    async init(containerRef: Ref<HTMLDivElement | undefined>, isDark: boolean) {
        this.isDark = isDark
        const { sciChartSurface, wasmContext } = await SciChartSurface.create(containerRef.value!, { theme: getTheme(isDark).sciChartTheme })

        this.surface = sciChartSurface
        this.wasmContext = wasmContext

        await this.surface.registerFont("Montserrat", "/Montserrat-Regular.ttf")

        const options: BasePanelOptions = {
            parentSurface: this.surface,
            wasmContext: this.wasmContext,
            isDark,
            modifiers: [
                { modifierClass: DragGuardModifier },
                { modifierClass: ZoomPanModifier, args: { xyDirection: EXyDirection.XDirection } },
                { modifierClass: MouseWheelZoomModifier, args: { xyDirection: EXyDirection.XDirection } },
                { modifierClass: ZoomExtentsModifier },
                { modifierClass: SeriesSelectionModifier, args: { enableSelection: true, enableHover: true } }
            ]
        }

        // The schedule timeline + promoter ('active') panels were removed from the
        // charts in the session-2 clean break (see docs/schedule-view-redesign.md):
        // the timeline returns as a standalone phase-D Vue component, and promoter
        // activity returns with the branch-aggregation track.
        this.tracks = [
            { id: 'elongations', panel: new CountsPanel(options, "Elongations") },
            { id: 'premrnas', panel: new CountsPanel(options, "Pre-mRNAs") },
            { id: 'mrnas', panel: new CountsPanel(options, "mRNAs") },
            { id: 'proteins', panel: new CountsPanel(options, "Proteins") },
            { id: 'other', panel: new CountsPanel(options, "Other species") }
        ]

        // -- Set up panel groups --
        this.timeseriesGroup = new PanelGroup("timeseries")
        for (const { id, panel } of this.tracks) {
            this.timeseriesGroup.add(id, panel)
        }

        this.phaseSpaceGroup = new PanelGroup("phasespace")

        // -- Set up layout tree (single group initially) --
        this.chartLayout = new ChartLayout()
        this.chartLayout.attach(this.surface)

        this.timeseriesLayoutNode = { kind: 'group', group: this.timeseriesGroup, xAxisLabel: "" }
        this.chartLayout.setRoot(this.timeseriesLayoutNode)

        // -- Scoped modifiers (all scoped to timeseries group) --
        this.axisSynchroniser = new AxisSyncModifier(this.timeseriesGroup)
        this.surface.chartModifiers.add(this.axisSynchroniser)

        this.timeCursorModifier = new SharedTimeCursorModifier(this.timeseriesGroup, isDark, t => this.timepointChangeCallback?.(t))
        this.surface.chartModifiers.add(this.timeCursorModifier)

        /** Groups timeseries by gene ID (prefix before ':'); excludes segment rectangles. */
        const geneGroupFn: GroupingFn = (name) => {
            if (name.startsWith('segment:')) return null
            const colonIndex = name.indexOf(':')
            return colonIndex >= 0 ? name.substring(0, colonIndex) : name
        }

        this.selectSyncModifier = new SelectSyncModifier(this.timeseriesGroup, geneGroupFn, genes => this.selectionChangeCallback?.(genes))
        this.surface.chartModifiers.add(this.selectSyncModifier)

        // Wire timeseries hover callbacks to all timeseries panels
        for (const { panel } of this.getTimeseriesPanels()) {
            panel.onPathHover(path => this.timeseriesPathHoverCallback?.(path))
            panel.onPathSelect(path => this.timeseriesPathSelectCallback?.(path))
            panel.onGeneHover(gene => this.timeseriesGeneHoverCallback?.(gene))
        }

        // Explicitly apply theme on the parent surface so SciChart's internal
        // previousThemeProvider is seeded. Without this, the first applyTheme
        // on a sub-surface crashes accessing parentSurface.previousThemeProvider.
        this.surface.applyTheme(getTheme(isDark).sciChartTheme)

        console.debug(`[MainChart] Initialised with ${this.tracks.length} tracks`)
    }

    onTimepointChange(callback: (timepoint: number) => void): void {
        this.timepointChangeCallback = callback
    }

    onSelectionChange(callback: SelectionChangeCallback): void {
        this.selectionChangeCallback = callback
    }

    /** Register a callback for when the user hovers over a path in a timeseries panel. */
    onTimeseriesPathHover(callback: (path: string | null) => void): void {
        this.timeseriesPathHoverCallback = callback
    }

    /** Register a callback for persistent trajectory-path selection. */
    onTimeseriesPathSelect(callback: (path: string) => void): void {
        this.timeseriesPathSelectCallback = callback
    }

    /** Register a callback for when the user hovers over a gene in a timeseries panel. */
    onTimeseriesGeneHover(callback: (gene: string | null) => void): void {
        this.timeseriesGeneHoverCallback = callback
    }

    /**
     * Dim all series in every panel except those belonging to `path`.
     * Pass null to restore all panels to full opacity.
     */
    highlightPath(path: ReadonlySet<string> | string | null): void {
        for (const { panel } of this.tracks) {
            panel.highlightPath(path)
        }
        this.phaseSpacePanel?.highlightPath(path)
    }

    /**
     * Dim all series in every panel except those belonging to `gene`.
     * Pass null to restore all panels to full opacity.
     * Composes with highlightPath — both filters apply simultaneously.
     */
    highlightGene(gene: string | null): void {
        for (const { panel } of this.tracks) {
            panel.highlightGene(gene)
        }
        this.phaseSpacePanel?.highlightGene(gene)
    }

    setScheduleBrush(range: { from: number; to: number } | null): void {
        for (const { panel } of this.tracks) panel.setScheduleBrush(range)
    }

    private getTimeseriesPanels(): Array<{ id: string; panel: TimeseriesPanel }> {
        return this.tracks
            .filter(({ panel }) => panel instanceof (CountsPanel as any))
            .map(({ id, panel }) => ({ id, panel: panel as TimeseriesPanel }))
    }

    setVisibleTracks(ids: string[]) {
        this.tracks.forEach(({ id, panel }) => {
            panel.isVisible = ids.includes(id)
        })
        this.chartLayout.updateLayout()
        this.timeCursorModifier?.onSubChartVisibilityChanged()
    }

    /**
     * Enable/disable user zoom & pan across all panels. Disabled during live
     * streaming so the viewport stays put (the animator drives the range); the
     * full pyramid-backed zoom/pan is available once the run finishes.
     */
    setZoomEnabled(enabled: boolean): void {
        for (const { panel } of this.tracks) {
            panel.surface.chartModifiers.asArray().forEach(m => {
                if (
                    m instanceof ZoomPanModifier ||
                    m instanceof MouseWheelZoomModifier ||
                    m instanceof ZoomExtentsModifier
                ) {
                    m.isEnabled = enabled
                }
            })
        }
    }

    /** Zoom all visible panels to fit their data on both axes. */
    zoomExtentsAll(): void {
        for (const { panel } of this.tracks) {
            if (!panel.isVisible) continue
            if (panel.surface.renderableSeries.asArray().length > 0) {
                panel.surface.zoomExtentsY()
                panel.surface.zoomExtentsX()
            }
        }
    }

    clear() {
        this.selectSyncModifier?.clearSelection()
        this.timeCursorModifier?.hideCursor()
        this.tracks.forEach(({ panel }) => {
            panel.clearData()
        })
    }

    dispose(): void {
        this.tracks?.forEach(({ panel }) => panel.dispose())
        this.phaseSpacePanel?.dispose()
        this.chartLayout?.dispose()
        // surface.delete() cascades to all sub-surfaces (including phase-space)
        this.surface?.delete()
    }

    /** Export the current chart as a high-quality PNG file download. */
    async exportImage(): Promise<void> {
        if (!this.surface) return
        const root = this.surface.domChartRoot
        const saveOpts = {
            filename: 'chart.png',
            mimeType: 'image/png',
            filterName: 'PNG Image',
            extensions: ['png'],
        }

        // Tauri/WKWebView: canvas compositing (html-to-image fails in foreignObject)
        if (isTauri()) {
            await this.surface.nextStateRender()
            const blob = await compositCanvasesToBlob(root)
            if (blob) {
                await saveFile(blob, saveOpts)
                return
            }
        }

        // Browser fallback: html-to-image
        root.style.position = 'relative'
        const blob = await toBlob(root, { pixelRatio: 10, skipFonts: true })
        if (blob) await saveFile(blob, saveOpts)
    }

    /** Re-apply the SciChart theme on dark-mode toggle. */
    applyTheme(isDark: boolean): void {
        this.isDark = isDark
        this.surface.applyTheme(getTheme(isDark).sciChartTheme)
        for (const { panel } of this.tracks) {
            panel.applyTheme(isDark)
        }
        this.phaseSpacePanel?.applyTheme(isDark)
        this.timeCursorModifier.applyColorTheme(isDark)
    }

    // ------------------------------------------------------------------
    // Adaptive viewport (server-side decimation)
    // ------------------------------------------------------------------

    private viewportChangeCallback?: (vp: Viewport) => void
    private viewportDebounce?: ReturnType<typeof setTimeout>

    /**
     * Current visible time window + pixel width of the timeseries area, used to
     * request screen-resolution data from the server pyramid. Reads the shared
     * (synced) x-axis of the first visible timeseries panel.
     */
    getViewport(): Viewport | null {
        for (const { panel } of this.getTimeseriesPanels()) {
            if (!panel.isVisible) continue
            const xAxis = panel.surface.xAxes.get(0)
            if (!xAxis) continue
            const range = xAxis.visibleRange
            const widthPx = Math.max(1, Math.round(panel.surface.seriesViewRect.width))
            if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max <= range.min) continue
            return { t0: range.min, t1: range.max, widthPx }
        }
        return null
    }

    /**
     * Fire `cb` (debounced) whenever the user zooms/pans the timeseries x-axis, so
     * the caller can re-query the pyramid at the new resolution. Wired to every
     * timeseries panel's x-axis since AxisSyncModifier keeps them in lock-step.
     */
    onViewportChange(cb: (vp: Viewport) => void): void {
        this.viewportChangeCallback = cb
        for (const { panel } of this.getTimeseriesPanels()) {
            const xAxis = panel.surface.xAxes.get(0)
            xAxis?.visibleRangeChanged.subscribe(() => this._scheduleViewportChange())
        }
    }

    private _scheduleViewportChange(): void {
        if (!this.viewportChangeCallback) return
        if (this.viewportDebounce) clearTimeout(this.viewportDebounce)
        this.viewportDebounce = setTimeout(() => {
            const vp = this.getViewport()
            if (vp) this.viewportChangeCallback!(vp)
        }, 150)
    }

    /**
     * Replace the rendered timeseries. By default fits both axes (initial load);
     * pass `fitAxes: false` for adaptive viewport refreshes, which keep the user's
     * current zoom/pan and only swap the data at the new resolution.
     */
    setSimulationData(timeseries: TimeseriesData, { fitAxes = true }: { fitAxes?: boolean } = {}): void {
        const scheduleStore = useScheduleStore()
        const timeseriesPanels = this.getTimeseriesPanels()

        timeseriesPanels.forEach(({ id, panel }) => {
            const speciesIds = new Set(scheduleStore.getSpeciesForSpeciesType(id as SpeciesType))
            const filteredTimeseries = Object.fromEntries(
                Object.entries(timeseries)
                    .filter(([species]) => speciesIds.has(species))
            ) as TimeseriesData
            let pointCount = 0
            for (const pathData of Object.values(filteredTimeseries)) {
                for (const points of Object.values(pathData)) pointCount += points.length
            }
            performance.mark('set-data-start')
            panel.setData(filteredTimeseries)
            const totalSeries = panel.surface.renderableSeries.size()
            performance.measure(`grs:set-data:${id}`, {
                start: 'set-data-start',
                detail: { pointCount, totalSeries },
            })
            // Fit axes only on a fresh load; viewport refreshes preserve the
            // user's zoom/pan (the x-range *is* the query that produced this data).
            // y is still re-fit so spikes surfaced at the new resolution stay framed.
            if (panel.surface.renderableSeries.asArray().length > 0) {
                panel.surface.zoomExtentsY()
                if (fitAxes) panel.surface.zoomExtentsX()
            }
        })

        // Series were recreated -- re-apply selection state so SelectSync stays consistent
        this.selectSyncModifier?.reapplySelection()
    }

    /** Replace one bounded live snapshot and move every time axis atomically per poll. */
    setLiveSnapshot(timeseries: TimeseriesData, windowStart: number, currentTime: number): void {
        this.setSimulationData(timeseries, { fitAxes: false })
        if (currentTime <= windowStart) return
        this.tracks.forEach(({ panel }) => panel.setVisibleTimeRange(windowStart, currentTime))
        this.timeCursorModifier?.setCursorTime(currentTime)
    }

    setScheduleData(segments: TimelineSegment[], metadata: TimeseriesMetadata): void {
        const pathTimeRanges = getPathTimeRanges(segments)
        const timeseriesPanels = this.getTimeseriesPanels()
        timeseriesPanels.forEach(({ panel }) => {
            panel.setMetadata(metadata)
            panel.setPathTimeRanges(pathTimeRanges)
        })
        this.tracks.forEach(({ panel }) => {
            panel.setTimeExtent(metadata.time_extent.min, metadata.time_extent.max)
        })
    }

    clearSimulationData(): void {
        this.selectSyncModifier?.clearSelection()
        this.timeCursorModifier?.hideCursor()
        this.getTimeseriesPanels().forEach(({ panel }) => panel.clearData())
        this.hidePhaseSpace()
    }

    // ------------------------------------------------------------------
    // Phase space API
    // ------------------------------------------------------------------

    /** Show the phase-space panel (creates it lazily), sets a horizontal split layout. */
    showPhaseSpace(result: PhaseSpaceResult): void {
        this._ensurePhaseSpacePanel()
        this.phaseSpacePanel!.isVisible = true
        this.phaseSpacePanel!.setPhaseSpaceData(result)
        this._applyPhaseSpaceLayout(true)
    }

    /** Hide the phase-space panel and revert to single-group layout. */
    hidePhaseSpace(): void {
        if (!this.phaseSpacePanel) return
        this.phaseSpacePanel.isVisible = false
        this.phaseSpacePanel.clearData()
        this._applyPhaseSpaceLayout(false)
    }

    /** Update data on an already-visible phase-space panel. */
    setPhaseSpaceData(result: PhaseSpaceResult): void {
        if (!this.phaseSpacePanel || !this.phaseSpacePanel.isVisible) {
            this.showPhaseSpace(result)
            return
        }
        this.phaseSpacePanel.setPhaseSpaceData(result)
    }

    /** Update the current-timepoint highlight on the phase-space panel. */
    setPhaseSpaceTimepoint(t: number): void {
        this.phaseSpacePanel?.setTimepoint(t)
    }

    /** Programmatically move the timeseries time cursor to a given time. */
    setCursorTime(t: number): void {
        this.timeCursorModifier?.setCursorTime(t)
    }

    /** Register a callback for when the user clicks a path in the phase-space view. */
    onPhaseSpacePathSelect(callback: (path: string) => void): void {
        this.phaseSpacePathSelectCallback = callback
        this.phaseSpacePanel?.onPathSelect(callback)
    }

    /** Register a callback for when the user hovers a point in the phase-space view. */
    onPhaseSpaceHover(callback: (info: HoverInfo | null) => void): void {
        this.phaseSpaceHoverCallback = callback
        this.phaseSpacePanel?.onHover(callback)
    }

    /** Whether the phase-space panel is currently shown. */
    get isPhaseSpaceVisible(): boolean {
        return this.phaseSpacePanel !== null && this.phaseSpacePanel.isVisible
    }

    // ------------------------------------------------------------------
    // Phase space internals
    // ------------------------------------------------------------------

    /** Create the phase-space panel once; subsequent calls are no-ops. */
    private _ensurePhaseSpacePanel(): void {
        if (this.phaseSpacePanel) return
        const options: BasePanelOptions = {
            parentSurface: this.surface,
            wasmContext: this.wasmContext,
            isDark: this.isDark,
        }
        this.phaseSpacePanel = new PhaseSpacePanel(options)
        this.phaseSpacePanel.isVisible = false  // hidden until explicitly shown
        this.phaseSpaceGroup.add("phasespace", this.phaseSpacePanel)

        if (this.phaseSpacePathSelectCallback) {
            this.phaseSpacePanel.onPathSelect(this.phaseSpacePathSelectCallback)
        }
        if (this.phaseSpaceHoverCallback) {
            this.phaseSpacePanel.onHover(this.phaseSpaceHoverCallback)
        }
    }

    /** Toggle layout between single-group (timeseries only) and horizontal split. */
    private _applyPhaseSpaceLayout(showPhaseSpace: boolean): void {
        let root: LayoutNode
        if (showPhaseSpace && this.phaseSpacePanel) {
            root = {
                kind: 'split',
                direction: 'horizontal',
                ratio: TIMESERIES_SPLIT_RATIO,
                a: this.timeseriesLayoutNode,
                b: { kind: 'group', group: this.phaseSpaceGroup, xAxisLabel: "" },
            }
        } else {
            root = this.timeseriesLayoutNode
        }
        this.chartLayout.setRoot(root)
    }
}
