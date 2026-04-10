/**
 * TimeseriesHoverModifier -- hover tooltip for timeseries sub-surfaces.
 *
 * Each series in a timeseries panel is named `geneId:path`.  On hover, this
 * modifier finds the nearest data point via hitTestNearest and shows a tooltip
 * with the gene, path, and y-value.
 *
 * Attach directly to each timeseries sub-surface (CountsPanel / PromoterPanel).
 * Uses shouldProcessEvent so only the sub-surface under the cursor responds.
 */
import {
    ChartModifierBase2D,
    EChart2DModifierType,
    type ModifierMouseArgs,
} from "scichart"
import { hitTestNearest, shouldProcessEvent } from "./hitTestUtils"

const HIT_TEST_RADIUS_CSS = 8

type PathHoverCallback = (path: string | null) => void
type GeneHoverCallback = (gene: string | null) => void

export class TimeseriesHoverModifier extends ChartModifierBase2D {
    public type = EChart2DModifierType.Custom
    private tooltipDiv: HTMLDivElement | null = null
    private pathHoverCallback?: PathHoverCallback
    private geneHoverCallback?: GeneHoverCallback
    private hoveredPath: string | null = null
    private hoveredGene: string | null = null

    /** Register a callback fired with the execution path on hover (null on leave). */
    onPathHover(cb: PathHoverCallback): void {
        this.pathHoverCallback = cb
    }

    /** Register a callback fired with the gene id on hover (null on leave). */
    onGeneHover(cb: GeneHoverCallback): void {
        this.geneHoverCallback = cb
    }

    override modifierMouseMove(args: ModifierMouseArgs): void {
        super.modifierMouseMove(args)
        if (!shouldProcessEvent(this.parentSurface, args)) return
        if (!this.mousePoint || !this.isAttached) return

        const series = this.parentSurface.renderableSeries.asArray().filter(rs => {
            const name = rs.dataSeries?.dataSeriesName ?? ''
            return name.length > 0 && !name.startsWith('__') && !name.startsWith('segment:')
        })

        const result = hitTestNearest(series, this.mousePoint, HIT_TEST_RADIUS_CSS)
        if (!result) {
            this._hideTooltip()
            if (this.hoveredPath !== null) {
                this.hoveredPath = null
                this.pathHoverCallback?.(null)
            }
            if (this.hoveredGene !== null) {
                this.hoveredGene = null
                this.geneHoverCallback?.(null)
            }
            return
        }

        const name = result.series.dataSeries?.dataSeriesName ?? ''
        const colonIdx = name.indexOf(':')
        const gene = colonIdx >= 0 ? name.substring(0, colonIdx) : name
        const path = colonIdx >= 0 ? name.substring(colonIdx + 1) : ''
        const value = result.hitTestInfo.yValue

        const label = Number.isFinite(value)
            ? `${gene}  ·  ${path}\n${value.toFixed(1)}`
            : `${gene}  ·  ${path}`

        if (this.hoveredPath !== path) {
            this.hoveredPath = path
            this.pathHoverCallback?.(path || null)
        }
        if (this.hoveredGene !== gene) {
            this.hoveredGene = gene
            this.geneHoverCallback?.(gene || null)
        }

        this._showTooltip(label, args)
    }

    override modifierMouseLeave(args: ModifierMouseArgs): void {
        super.modifierMouseLeave(args)
        this._hideTooltip()
        if (this.hoveredPath !== null) {
            this.hoveredPath = null
            this.pathHoverCallback?.(null)
        }
        if (this.hoveredGene !== null) {
            this.hoveredGene = null
            this.geneHoverCallback?.(null)
        }
    }

    dispose(): void {
        this.tooltipDiv?.remove()
        this.tooltipDiv = null
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

    private _hideTooltip(): void {
        if (this.tooltipDiv) this.tooltipDiv.style.display = 'none'
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
}
