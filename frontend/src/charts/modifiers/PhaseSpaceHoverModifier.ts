/**
 * Custom SciChart modifier for phase-space hover interaction.
 *
 * Uses the shared hitTestNearest utility (which delegates to SciChart's
 * hitTestProvider) for reliable sub-surface-aware hit-testing.
 * Provides path dimming, tooltip, and hover callback.
 */
import {
    ChartModifierBase2D,
    EChart2DModifierType,
    FastLineRenderableSeries,
    XyScatterRenderableSeries,
    type ModifierMouseArgs,
} from "scichart"
import { hitTestNearest, shouldProcessEvent } from "./hitTestUtils"
import { formatTime } from "../timeFormat"

const HIT_TEST_RADIUS_CSS = 10
const DIM_OPACITY = 0.1

/** Stroke thickness: normal / highlighted path. */
const LINE_THICKNESS_NORMAL = 3.0
const LINE_THICKNESS_HOVER = 4.0

/** Scatter point size: normal / highlighted / dimmed path. */
const POINT_SIZE_NORMAL = 5
const POINT_SIZE_HOVER = 7
const POINT_SIZE_DIM = 3

export type HoverInfo = { t: number; path: string }
type HoverCallback = (info: HoverInfo | null) => void

/** Extract path name from a scatter series dataSeriesName like "scatter:k3-1". */
function extractPath(name: string | undefined): string | null {
    if (!name?.startsWith('scatter:')) return null
    return name.substring(8)
}

export class PhaseSpaceHoverModifier extends ChartModifierBase2D {
    public type = EChart2DModifierType.Custom
    private hoverCallback?: HoverCallback
    private hoveredPath: string | null = null
    private lastHoverInfo: HoverInfo | null = null
    private tooltipDiv: HTMLDivElement | null = null
    /** Lookup from path -> time for each scatter data point index. */
    private pathTimeMap = new Map<string, number[]>()

    /** Whether the modifier is currently hovering a path (used by PhaseSpacePanel to guard external highlight). */
    get isHovering(): boolean { return this.hoveredPath !== null }

    /** Register the hover callback (fires with nearest point info, or null on leave). */
    onHover(cb: HoverCallback): void {
        this.hoverCallback = cb
    }

    /** Store time values per path so we can resolve dataSeriesIndex -> t. */
    setPathTimes(pathTimes: Map<string, number[]>): void {
        this.pathTimeMap = pathTimes
    }

    override modifierMouseMove(args: ModifierMouseArgs): void {
        super.modifierMouseMove(args)
        if (!shouldProcessEvent(this.parentSurface, args)) return
        if (!this.mousePoint || !this.isAttached) return

        // Filter to scatter series only (one per path)
        const scatterSeries = this.parentSurface.renderableSeries
            .asArray()
            .filter(rs => extractPath(rs.dataSeries?.dataSeriesName) !== null)

        const result = hitTestNearest(scatterSeries, this.mousePoint, HIT_TEST_RADIUS_CSS)

        if (!result) {
            this._clearHover(args)
            return
        }

        const bestPath = extractPath(result.series.dataSeries?.dataSeriesName)
        const bestIndex = result.hitTestInfo.dataSeriesIndex
        if (!bestPath || bestIndex < 0) {
            this._clearHover(args)
            return
        }

        const times = this.pathTimeMap.get(bestPath)
        const t = times?.[bestIndex]
        if (t === undefined) {
            this._clearHover(args)
            return
        }

        // Skip redundant events for same point
        if (this.lastHoverInfo?.t === t && this.lastHoverInfo?.path === bestPath) {
            this._updateTooltipPosition(args)
            return
        }

        this.lastHoverInfo = { t, path: bestPath }

        if (this.hoveredPath !== bestPath) {
            this.hoveredPath = bestPath
            this._dimPathsExcept(bestPath)
        }

        this._showTooltip(`${bestPath}\nt = ${formatTime(t)}`, args)
        this.hoverCallback?.({ t, path: bestPath })
    }

    override modifierMouseLeave(args: ModifierMouseArgs): void {
        super.modifierMouseLeave(args)
        this._clearHover(args)
    }

    dispose(): void {
        if (this.tooltipDiv) {
            document.body.removeChild(this.tooltipDiv)
            this.tooltipDiv = null
        }
    }

    // ------------------------------------------------------------------
    // Path dimming
    // ------------------------------------------------------------------

    private _dimPathsExcept(activePath: string): void {
        if (!this.isAttached) return
        for (const rs of this.parentSurface.renderableSeries.asArray()) {
            const name = rs.dataSeries?.dataSeriesName ?? ''
            if (name.startsWith('__')) continue // skip highlight
            const isLine = name.startsWith('line:')
            const isScatter = name.startsWith('scatter:')
            if (!isLine && !isScatter) continue
            const path = name.substring(name.indexOf(':') + 1)
            const active = path === activePath
            rs.opacity = active ? 1 : DIM_OPACITY
            if (isLine && rs instanceof FastLineRenderableSeries) {
                rs.strokeThickness = active ? LINE_THICKNESS_HOVER : LINE_THICKNESS_NORMAL
            }
            if (isScatter && rs instanceof XyScatterRenderableSeries && rs.pointMarker) {
                const sz = active ? POINT_SIZE_HOVER : POINT_SIZE_DIM
                rs.pointMarker.width = sz
                rs.pointMarker.height = sz
            }
        }
    }

    private _restorePathOpacity(): void {
        if (!this.isAttached) return
        for (const rs of this.parentSurface.renderableSeries.asArray()) {
            const name = rs.dataSeries?.dataSeriesName ?? ''
            if (name.startsWith('__')) continue
            if (name.startsWith('line:')) {
                rs.opacity = 1
                if (rs instanceof FastLineRenderableSeries) {
                    rs.strokeThickness = LINE_THICKNESS_NORMAL
                }
            } else if (name.startsWith('scatter:')) {
                rs.opacity = 1
                if (rs instanceof XyScatterRenderableSeries && rs.pointMarker) {
                    rs.pointMarker.width = POINT_SIZE_NORMAL
                    rs.pointMarker.height = POINT_SIZE_NORMAL
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Tooltip
    // ------------------------------------------------------------------

    private _showTooltip(text: string, args: ModifierMouseArgs): void {
        if (!this.tooltipDiv) {
            this.tooltipDiv = this._createTooltipDiv()
        }
        this.tooltipDiv.textContent = text
        const ne = args.nativeEvent
        if (ne) {
            this.tooltipDiv.style.left = `${ne.clientX + 12}px`
            this.tooltipDiv.style.top = `${ne.clientY - 20}px`
        }
        this.tooltipDiv.style.display = 'block'
    }

    private _updateTooltipPosition(args: ModifierMouseArgs): void {
        if (!this.tooltipDiv || this.tooltipDiv.style.display === 'none') return
        const ne = args.nativeEvent
        if (ne) {
            this.tooltipDiv.style.left = `${ne.clientX + 12}px`
            this.tooltipDiv.style.top = `${ne.clientY - 20}px`
        }
    }

    private _hideTooltip(): void {
        if (this.tooltipDiv) {
            this.tooltipDiv.style.display = 'none'
        }
    }

    private _createTooltipDiv(): HTMLDivElement {
        const el = document.createElement('div')
        el.className = 'grs-tooltip'
        Object.assign(el.style, {
            position: 'fixed',
            display: 'none',
            pointerEvents: 'none',
            zIndex: '9999',
            whiteSpace: 'pre',
        })
        document.body.appendChild(el)
        return el
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private _clearHover(_args: ModifierMouseArgs): void {
        if (this.hoveredPath !== null) {
            this.hoveredPath = null
            this.lastHoverInfo = null
            this._restorePathOpacity()
            this._hideTooltip()
            this.hoverCallback?.(null)
        }
    }
}
