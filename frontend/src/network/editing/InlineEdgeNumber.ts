/**
 * InlineEdgeNumber - inline numeric editor anchored to an edge's label.
 *
 * Used to edit the stoichiometry shown on auxiliary substrate/product edges:
 * click the number, type a new integer, Enter/blur commits. The input is a DOM
 * overlay positioned at the edge's rendered midpoint (where the label sits) and
 * follows pan/zoom. Mirrors InlineRename's lifecycle, but anchors to an edge
 * rather than a node label region.
 *
 * Value parsing: a non-negative integer commits; anything else cancels. `0` is
 * a valid commit (the backend treats it as "remove this reagent").
 */
import type { Core } from 'cytoscape'
import { createInlineInput } from './inlineEdit'
import { getTheme } from '@/config/theme'
import { STOICH_LABEL_STYLE } from '../networkStyles'

export interface EdgeNumberConfig {
    edgeId: string
    initialValue: number
    /** Called with the parsed non-negative integer on a valid commit. */
    onCommit: (value: number) => void
}

export class InlineEdgeNumber {
    private cy: Core | null = null
    private isDark = false

    private active: {
        ele: any
        container: HTMLDivElement
        input: HTMLInputElement
        dispose: () => void
    } | null = null
    private onViewportChange: (() => void) | null = null
    private pendingFrame: number | null = null

    attach(cy: Core, isDark = false): void {
        this.cy = cy
        this.isDark = isDark
    }

    applyTheme(isDark: boolean): void {
        this.isDark = isDark
        if (this.active) this.applyInputTheme(this.active.input)
    }

    start(config: EdgeNumberConfig): void {
        if (!this.cy) return
        const ele = this.cy.getElementById(config.edgeId)
        if (!ele || ele.empty() || !ele.isEdge()) return
        this.cancel()

        const host = this.cy.container()
        if (!host) return
        if (getComputedStyle(host).position === 'static') {
            host.style.position = 'relative'
        }

        const container = document.createElement('div')
        Object.assign(container.style, {
            position: 'absolute',
            left: '0',
            top: '0',
            zIndex: '60',
            transform: 'translate3d(-9999px, -9999px, 0)',
            pointerEvents: 'auto',
            willChange: 'transform',
        } as Partial<CSSStyleDeclaration>)

        const handle = createInlineInput({
            initialValue: String(config.initialValue),
            minWidthCh: 2,
            onCommit: (raw) => {
                this.cleanup()
                const v = Number(raw.trim())
                if (Number.isInteger(v) && v >= 0) config.onCommit(v)
            },
            onCancel: () => this.cleanup(),
        })
        const { input, focusAndSelect } = handle
        input.inputMode = 'numeric'
        this.applyInputTheme(input)

        container.appendChild(input)
        host.appendChild(container)

        this.active = { ele, container, input, dispose: handle.dispose }
        this.position()
        focusAndSelect()

        this.onViewportChange = () => this.scheduleUpdate()
        this.cy.on('pan zoom resize', this.onViewportChange)
        this.cy.on('position', 'node', this.onViewportChange)
    }

    destroy(): void {
        this.cancel()
        this.cy = null
    }

    private cancel(): void {
        if (this.active) this.cleanup()
    }

    private cleanup(): void {
        if (this.pendingFrame !== null) {
            cancelAnimationFrame(this.pendingFrame)
            this.pendingFrame = null
        }
        if (this.cy && this.onViewportChange) {
            this.cy.off('pan zoom resize', this.onViewportChange)
            this.cy.off('position', 'node', this.onViewportChange)
            this.onViewportChange = null
        }
        if (this.active) {
            this.active.dispose()
            this.active.container.remove()
            this.active = null
        }
    }

    private scheduleUpdate(): void {
        if (this.pendingFrame !== null) return
        this.pendingFrame = requestAnimationFrame(() => {
            this.pendingFrame = null
            this.position()
        })
    }

    private position(): void {
        if (!this.active || !this.cy) return
        const mid = this.active.ele.renderedMidpoint()
        const zoom = this.cy.zoom()
        this.active.container.style.fontSize = `${STOICH_LABEL_STYLE.fontSize * zoom}px`
        this.active.container.style.transform =
            `translate3d(${mid.x.toFixed(1)}px, ${mid.y.toFixed(1)}px, 0) translate(-50%, -50%)`
    }

    private applyInputTheme(input: HTMLInputElement): void {
        const colour = getTheme(this.isDark).network.speciesEdgeLabelText
        Object.assign(input.style, {
            padding: '0 0.2em',
            border: 'none',
            borderBottom: `2px solid ${colour}`,
            background: getTheme(this.isDark).network.reactionBg ?? 'transparent',
            color: colour,
            fontFamily: STOICH_LABEL_STYLE.fontFamily,
            fontWeight: 'normal',
            fontSize: 'inherit',
            outline: 'none',
            textAlign: 'center',
        } as Partial<CSSStyleDeclaration>)
    }
}
