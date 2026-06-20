/**
 * InlineRename - inline rename overlay for any labelled node.
 *
 * The overlay is a DOM input positioned over the cytoscape label. While
 * active we add the `.renaming` class to the node, which the stylesheet uses
 * to hide the canvas label (text-opacity: 0); the DOM input is the only label
 * visible. Originally gene-specific (hence the gene-flavoured docs in
 * `networkStyles`), it now drives both gene-compound and reaction-node
 * renaming — the caller supplies the per-target `initialValue`, label
 * typography, collision `validate`, and `onCommit` via the start config.
 *
 * Positioning derives from `renderedBoundingBox({ includeLabels })` —
 * subtracting the no-labels bbox from the with-labels bbox reveals the label
 * region in rendered space, which is robust to `text-valign` choice (label
 * above a compound, below a node, or centred on a dot) and to zoom.
 *
 * Validation: invalid input gets a red border and is not committed; the input
 * stays open so the user can fix it.
 */
import type { Core } from 'cytoscape'
import { createInlineInput } from './inlineEdit'
import { getTheme } from '@/config/theme'

/** Typography for the overlay input, in cytoscape model units (scaled by zoom). */
export interface RenameLabelStyle {
    fontFamily: string
    /** Font size in model units — matches the canvas label so the input tracks it. */
    fontSize: number
}

/** Per-invocation configuration for a rename. */
export interface InlineRenameConfig {
    /** Cytoscape id of the node whose label is being edited. */
    nodeId: string
    /** Value the input opens with (the clean current name, no decorations). */
    initialValue: string
    labelStyle: RenameLabelStyle
    /** Returns true if `newName` is an acceptable commit (collisions, etc.). */
    validate: (newName: string) => boolean
    /** Called with the trimmed new name once it validates and differs. */
    onCommit: (newName: string) => void
}

export class InlineRename {
    private cy: Core | null = null
    private isDark = false

    private active: {
        config: InlineRenameConfig
        ele: any
        container: HTMLDivElement
        input: HTMLInputElement
        dispose: () => void
        rearm: () => void
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

    start(config: InlineRenameConfig): void {
        if (!this.cy) return
        const ele = this.cy.getElementById(config.nodeId)
        if (!ele || ele.empty()) return
        this.cancel()

        const host = this.cy.container()
        if (!host) return
        if (getComputedStyle(host).position === 'static') {
            host.style.position = 'relative'
        }

        // Hide the canvas label so the overlay is the only label visible.
        ele.addClass('renaming')

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

        const initial = config.initialValue
        const handle = createInlineInput({
            initialValue: initial,
            onCommit: (raw) => {
                const newName = raw.trim()
                if (!config.validate(newName)) {
                    // Keep input visible; re-arm so the next Enter/blur is
                    // a fresh commit attempt instead of a no-op. Without
                    // this, `createInlineInput`'s single-fire guard leaves
                    // the input stuck after the first invalid attempt.
                    this.flashInvalid()
                    this.active?.rearm()
                    return
                }
                this.cleanup()
                if (newName && newName !== initial) {
                    config.onCommit(newName)
                }
            },
            onCancel: () => this.cleanup(),
        })
        const { input, focusAndSelect } = handle
        this.applyInputTheme(input)

        container.appendChild(input)
        host.appendChild(container)

        this.active = {
            config, ele, container, input,
            dispose: handle.dispose,
            rearm: handle.rearm,
        }
        this.position()
        focusAndSelect()

        this.onViewportChange = () => this.scheduleUpdate()
        this.cy.on('pan zoom resize', this.onViewportChange)
        this.cy.on('position', 'node', this.onViewportChange)

        // Wipe the red border as soon as the user edits — feedback should
        // only persist until the next keystroke.
        input.addEventListener('input', () => {
            input.style.borderBottomColor = this.borderColour()
        })
    }

    destroy(): void {
        this.cancel()
        this.cy = null
    }

    private cancel(): void {
        if (!this.active) return
        this.cleanup()
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
            // dispose BEFORE removing from DOM so removal-triggered blur
            // doesn't fire a spurious commit.
            this.active.dispose()
            this.active.ele.removeClass('renaming')
            this.active.container.remove()
            this.active = null
        }
    }

    private flashInvalid(): void {
        if (!this.active) return
        const t = getTheme(this.isDark)
        // Tailwind/PrimeVue palettes don't expose error red directly; fall
        // back to a known-bad color. The input listener restores normal.
        this.active.input.style.borderBottomColor = (t as any).network?.errorRed ?? '#ef4444'
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
        const ele = this.active.ele
        // Use the label region directly: (with-labels bbox) - (without-labels
        // bbox) gives a strip containing the label. Works for any
        // text-valign (top/center/bottom) and scales with zoom.
        const bbWith = ele.renderedBoundingBox({ includeLabels: true })
        const bbWithout = ele.renderedBoundingBox({ includeLabels: false })

        let cx: number
        let cy: number
        if (bbWith.y1 < bbWithout.y1 - 1) {
            // label sits above the node (compound parent)
            cx = (bbWith.x1 + bbWith.x2) / 2
            cy = (bbWith.y1 + bbWithout.y1) / 2
        } else if (bbWith.y2 > bbWithout.y2 + 1) {
            // label sits below the node
            cx = (bbWith.x1 + bbWith.x2) / 2
            cy = (bbWith.y2 + bbWithout.y2) / 2
        } else {
            // label is inside the node (text-valign: center)
            const p = ele.renderedPosition()
            cx = p.x
            cy = p.y
        }

        const zoom = this.cy.zoom()
        this.active.container.style.fontSize = `${this.active.config.labelStyle.fontSize * zoom}px`
        this.active.container.style.transform =
            `translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0) translate(-50%, -50%)`
    }

    private borderColour(): string {
        return getTheme(this.isDark).network.geneLabelText
    }

    private applyInputTheme(input: HTMLInputElement): void {
        Object.assign(input.style, {
            padding: '0 0.2em',
            border: 'none',
            borderBottom: `2px solid ${this.borderColour()}`,
            background: 'transparent',
            color: this.borderColour(),
            fontFamily: this.active?.config.labelStyle.fontFamily ?? 'inherit',
            fontWeight: 'normal',
            fontSize: 'inherit',
            outline: 'none',
            textAlign: 'center',
        } as Partial<CSSStyleDeclaration>)
    }
}
