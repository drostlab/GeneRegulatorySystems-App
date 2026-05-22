/**
 * InlineParameters - per-parameter DOM chips anchored to network elements.
 *
 * For each editable element (regulatory edge or reaction node) that exposes
 * a non-empty `data.parameters` array, this attaches a popper-anchored
 * container of small chips, one per parameter. Each chip displays
 * `name=value` (value resolved against the currently active model via the
 * supplied `parameterLookup`) and can be clicked to swap in a text input
 * for inline editing.
 *
 * Visual style mirrors Cytoscape's edge-label rendering: same theme colours
 * (`edgeLabelText` / `edgeLabelBg`), Montserrat font, and scales with the
 * cytoscape zoom level so chips don't look fixed-size when the user zooms.
 *
 * Lifecycle:
 *   const inline = new InlineParameters()
 *   inline.setParameterLookup(...)
 *   inline.onParameterChange = (symbol, value) => { ... }
 *   inline.attach(cy, isDark)
 *   inline.refreshValues()        // call when active model changes
 *   inline.applyTheme(isDark)     // call when dark mode toggles
 *   inline.destroy()
 */
import type { Core } from 'cytoscape'
import type { Parameter } from '@/types/network'
import { getTheme } from '@/config/theme'

export type ParameterValueLookup = (symbol: string) => number | undefined

export type ParameterChangeHandler = (
    symbol: string,
    value: number,
) => void

/** Edge kinds that expose inline editable parameters. */
const REGULATORY_EDGE_KINDS = new Set([
    'activation',
    'repression',
    'proteolysis',
])

/** Node kinds that expose inline editable parameters. */
const EDITABLE_NODE_KINDS = new Set(['reaction'])

/**
 * Per-target base font size at cytoscape zoom=1.0, matched to the canvas
 * label `font-size` in `buildStylesheet` so chips and canvas labels look
 * the same size at every zoom level.
 *
 *   regulatory edges  → 7   (matches `selector: edge` font-size)
 *   ...in species view → 3   (matches `selector: edge.species-view`)
 *   reaction nodes    → 1.4 (matches `selector: node.reaction`)
 */
const BASE_FONT_SIZE_PX: Record<string, number> = {
    activation: 7,
    repression: 7,
    proteolysis: 7,
    reaction: 1.4,
}
const SPECIES_VIEW_EDGE_FONT_SIZE = 2
const DEFAULT_BASE_FONT_SIZE_PX = 7

interface Anchor {
    popper: any
    container: HTMLDivElement
    ele: any
    baseFontSize: number
}

export class InlineParameters {
    private cy: Core | null = null
    private anchors = new Map<string, Anchor>()
    private isDark = false

    private lookup: ParameterValueLookup = () => undefined
    private handler: ParameterChangeHandler | null = null

    private onAdd: ((evt: any) => void) | null = null
    private onRemove: ((evt: any) => void) | null = null
    private onViewportChange: (() => void) | null = null
    private onZoom: (() => void) | null = null

    /** rAF id for the pending update, so multiple events coalesce to one frame. */
    private pendingFrame: number | null = null

    /**
     * Notified when the cursor enters or moves over a parameter chip.
     * `ele` is the underlying cytoscape element (edge or node) the chip
     * belongs to; `(clientX, clientY)` are viewport coords. NetworkView
     * uses these to surface the same tooltip the underlying element would
     * have shown on a direct hover, via the shared GRS tooltip singleton.
     */
    onChipHover: ((ele: any, clientX: number, clientY: number) => void) | null = null

    /** Notified when the cursor leaves a parameter chip. */
    onChipLeave: (() => void) | null = null

    setParameterLookup(lookup: ParameterValueLookup): void {
        this.lookup = lookup
        this.refreshValues()
    }

    set onParameterChange(handler: ParameterChangeHandler | null) {
        this.handler = handler
    }

    attach(cy: Core, isDark = false): void {
        this.cy = cy
        this.isDark = isDark

        // Initial pass: create chips for elements present at attach time.
        cy.elements().forEach(el => this.maybeCreateAnchor(el))

        // Dynamic add/remove: AdaptiveZoom swaps in species/reaction nodes
        // when crossing the zoom threshold, so chips for those appear lazily.
        this.onAdd = (evt: any) => this.maybeCreateAnchor(evt.target)
        this.onRemove = (evt: any) => this.removeAnchor(String(evt.target.id()))

        // Reposition all chips on pan / zoom / resize / element move.
        // All triggers coalesce into one rAF-batched update per frame so
        // popper measurements happen after layout settles -> smooth zoom.
        this.onViewportChange = () => this.scheduleUpdate()
        this.onZoom = () => {
            this.applyZoomScale()
            this.scheduleUpdate()
        }

        cy.on('add', 'edge, node', this.onAdd)
        cy.on('remove', 'edge, node', this.onRemove)
        cy.on('pan resize', this.onViewportChange)
        cy.on('position', 'node', this.onViewportChange)
        cy.on('zoom', this.onZoom)

        this.applyZoomScale()
    }

    /** Re-read all chip values from the lookup (after active model change). */
    refreshValues(): void {
        for (const anchor of this.anchors.values()) {
            this.refreshAnchorValues(anchor)
        }
        // Active model may also have flipped visibility via .excluded.
        this.scheduleUpdate()
    }

    /** Reapply theme colours (call when dark mode toggles). */
    applyTheme(isDark: boolean): void {
        this.isDark = isDark
        const styles = this.chipStyles()
        for (const anchor of this.anchors.values()) {
            const chips = anchor.container.querySelectorAll<HTMLElement>('.param-chip')
            chips.forEach(chip => {
                if (chip.dataset.editing === 'true') return
                Object.assign(chip.style, styles.chipIdle)
            })
        }
    }

    destroy(): void {
        if (this.pendingFrame !== null) {
            cancelAnimationFrame(this.pendingFrame)
            this.pendingFrame = null
        }
        if (this.cy) {
            if (this.onAdd) this.cy.off('add', 'edge, node', this.onAdd)
            if (this.onRemove) this.cy.off('remove', 'edge, node', this.onRemove)
            if (this.onViewportChange) {
                this.cy.off('pan resize', this.onViewportChange)
                this.cy.off('position', 'node', this.onViewportChange)
            }
            if (this.onZoom) this.cy.off('zoom', this.onZoom)
        }
        for (const a of this.anchors.values()) {
            try { a.popper?.destroy?.() } catch { /* noop */ }
            a.container.remove()
        }
        this.anchors.clear()
        this.cy = null
        this.onAdd = null
        this.onRemove = null
        this.onViewportChange = null
        this.onZoom = null
    }

    // ========================================================================
    // Internal
    // ========================================================================

    private maybeCreateAnchor(ele: any): void {
        const id = String(ele.id())
        if (this.anchors.has(id)) return

        const params = (ele.data('parameters') ?? []) as Parameter[]
        if (params.length === 0) return

        const kind = String(ele.data('kind') ?? '')
        if (ele.isEdge() && !REGULATORY_EDGE_KINDS.has(kind)) return
        if (ele.isNode() && !EDITABLE_NODE_KINDS.has(kind)) return

        const container = document.createElement('div')
        container.className = 'inline-params'
        Object.assign(container.style, this.containerStyles())

        for (const p of params) {
            container.appendChild(this.createChip(p, ele))
        }

        // Reactions sit BELOW their canvas label (which is the reaction name);
        // edges sit ABOVE the edge so they don't overlap nodes.
        const placement = ele.isNode() && kind === 'reaction' ? 'bottom' : 'top'

        const popper = ele.popper({
            content: () => {
                const host = this.cy?.container() ?? document.body
                if (host) {
                    if (getComputedStyle(host).position === 'static') {
                        host.style.position = 'relative'
                    }
                    host.appendChild(container)
                }
                return container
            },
            popper: {
                placement,
                modifiers: [
                    { name: 'offset', options: { offset: [0, 2] } },
                    // Keep chips locked to the edge midpoint regardless of
                    // viewport — no shifting to stay on screen.
                    { name: 'flip', enabled: false },
                    { name: 'preventOverflow', enabled: false },
                ],
            },
        })

        const baseFontSize = BASE_FONT_SIZE_PX[kind] ?? DEFAULT_BASE_FONT_SIZE_PX
        const anchor: Anchor = { popper, container, ele, baseFontSize }
        // Apply the current zoom so newly-created chips don't briefly render
        // at the unscaled baseline.
        if (this.cy) {
            container.style.fontSize = `${this.effectiveBaseFontSize(anchor) * this.cy.zoom()}px`
        }
        this.anchors.set(id, anchor)
    }

    private removeAnchor(id: string): void {
        const a = this.anchors.get(id)
        if (!a) return
        try { a.popper?.destroy?.() } catch { /* noop */ }
        a.container.remove()
        this.anchors.delete(id)
    }

    /**
     * Schedule one popper.update() per anchor on the next frame, coalescing
     * multiple events (zoom + pan + position) that arrive within the same
     * frame into a single update. Running synchronously in the event handler
     * caused stuttering because layout hadn't yet settled from the font-size
     * change.
     */
    private scheduleUpdate(): void {
        if (this.pendingFrame !== null) return
        this.pendingFrame = requestAnimationFrame(() => {
            this.pendingFrame = null
            this.updateAll()
        })
    }

    private updateAll(): void {
        for (const a of this.anchors.values()) {
            const visible = typeof a.ele.visible === 'function' ? a.ele.visible() : true
            a.container.style.display = visible ? 'flex' : 'none'
            if (visible) {
                try { a.popper?.update?.() } catch { /* noop */ }
            }
        }
    }

    /**
     * Called by NetworkView when AdaptiveZoom toggles species view, so chips
     * pick up the smaller `.species-view` regulatory font-size (matches the
     * canvas style) without waiting for the next zoom event.
     */
    notifyDetailChanged(): void {
        this.applyZoomScale()
        this.scheduleUpdate()
    }

    private effectiveBaseFontSize(anchor: Anchor): number {
        // Regulatory edges shrink in species view to match
        // `selector: edge.species-view { font-size: 3 }`.
        if (anchor.ele.isEdge?.() && anchor.ele.hasClass?.('species-view')) {
            return SPECIES_VIEW_EDGE_FONT_SIZE
        }
        return anchor.baseFontSize
    }

    private applyZoomScale(): void {
        if (!this.cy) return
        const zoom = this.cy.zoom()
        // Per-anchor base size matches the canvas-label font-size for that
        // element kind (and view mode), so chips and labels look the same
        // size at any zoom.
        for (const a of this.anchors.values()) {
            a.container.style.fontSize = `${this.effectiveBaseFontSize(a) * zoom}px`
        }
    }

    private refreshAnchorValues(anchor: Anchor): void {
        const chips = anchor.container.querySelectorAll<HTMLElement>('.param-chip')
        chips.forEach(chip => {
            if (chip.dataset.editing === 'true') return
            this.renderChipText(chip)
        })
    }

    private createChip(p: Parameter, ele: any): HTMLElement {
        const chip = document.createElement('span')
        chip.className = 'param-chip'
        chip.dataset.symbol = p.symbol
        chip.dataset.name = p.name
        chip.dataset.editing = 'false'
        Object.assign(chip.style, this.chipStyles().chipIdle)

        // Read styles fresh inside the handlers so a theme toggle while a
        // chip is alive doesn't leave hover/leave returning to the old theme.
        chip.addEventListener('mouseenter', e => {
            if (chip.dataset.editing === 'true') return
            Object.assign(chip.style, this.chipStyles().chipHover)
            this.fireChipHover(ele, e)
        })
        chip.addEventListener('mousemove', e => {
            // Keep the tooltip tracking the cursor while the chip is hovered.
            if (chip.dataset.editing === 'true') return
            this.fireChipHover(ele, e)
        })
        chip.addEventListener('mouseleave', () => {
            if (chip.dataset.editing === 'true') return
            Object.assign(chip.style, this.chipStyles().chipIdle)
            this.onChipLeave?.()
        })
        // Don't initiate a pan when interacting with the chip.
        chip.addEventListener('mousedown', e => e.stopPropagation())
        chip.addEventListener('click', e => {
            e.stopPropagation()
            this.beginEdit(chip)
        })

        this.renderChipText(chip)
        return chip
    }

    private fireChipHover(ele: any, e: MouseEvent): void {
        this.onChipHover?.(ele, e.clientX, e.clientY)
    }

    private renderChipText(chip: HTMLElement): void {
        const sym = chip.dataset.symbol!
        const name = chip.dataset.name!
        const v = this.lookup(sym)
        chip.textContent = `${name}=${v === undefined ? '?' : formatValue(v)}`
    }

    private beginEdit(chip: HTMLElement): void {
        if (chip.dataset.editing === 'true') return
        const sym = chip.dataset.symbol!
        const name = chip.dataset.name!
        const current = this.lookup(sym)

        chip.dataset.editing = 'true'
        Object.assign(chip.style, this.chipStyles().chipEditing)

        const wrapper = document.createElement('span')
        wrapper.style.display = 'inline-flex'
        wrapper.style.alignItems = 'center'
        wrapper.style.gap = '1px'

        const label = document.createElement('span')
        label.textContent = `${name}=`

        const input = document.createElement('input')
        input.type = 'text'
        input.value = current === undefined ? '' : String(current)
        Object.assign(input.style, this.inputStyles(input.value.length))

        wrapper.appendChild(label)
        wrapper.appendChild(input)
        chip.replaceChildren(wrapper)

        requestAnimationFrame(() => {
            input.focus()
            input.select()
        })

        const cleanup = () => {
            chip.dataset.editing = 'false'
            Object.assign(chip.style, this.chipStyles().chipIdle)
            this.renderChipText(chip)
        }

        const commit = () => {
            const parsed = Number(input.value)
            if (!Number.isFinite(parsed)) { cleanup(); return }
            const previous = this.lookup(sym)
            if (previous !== undefined && parsed === previous) { cleanup(); return }
            cleanup()
            this.handler?.(sym, parsed)
        }
        const cancel = () => cleanup()

        let finished = false
        const finishOnce = (fn: () => void) => () => {
            if (finished) return
            finished = true
            input.removeEventListener('blur', onBlur)
            fn()
        }
        const onBlur = finishOnce(commit)
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); finishOnce(commit)() }
            else if (e.key === 'Escape') { e.preventDefault(); finishOnce(cancel)() }
        })
        input.addEventListener('input', () => {
            input.style.width = `${Math.max(4, input.value.length + 1)}ch`
        })
        input.addEventListener('blur', onBlur)
    }

    // ========================================================================
    // Theme-driven styles
    // ========================================================================

    private containerStyles(): Partial<CSSStyleDeclaration> {
        return {
            position: 'absolute',
            display: 'flex',
            gap: '0.3em',
            alignItems: 'center',
            pointerEvents: 'auto',
            zIndex: '50',
            fontFamily: 'Montserrat, sans-serif',
            fontSize: `${BASE_FONT_SIZE_PX}px`, // overwritten by applyZoomScale
            lineHeight: '1.2',
        }
    }

    private chipStyles(): {
        chipIdle: Partial<CSSStyleDeclaration>
        chipHover: Partial<CSSStyleDeclaration>
        chipEditing: Partial<CSSStyleDeclaration>
    } {
        const t = getTheme(this.isDark)
        // Match canvas edge-label rendering: text-background-color + 0.7 opacity,
        // edgeLabelText for foreground.
        const bg = withAlpha(t.network.edgeLabelBg, 0.7)
        const bgHover = withAlpha(t.network.edgeLabelBg, 1.0)
        return {
            chipIdle: {
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 0.3em',
                borderRadius: '0.3em',
                background: bg,
                color: t.network.edgeLabelText,
                border: 'none',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                userSelect: 'none',
                transition: 'background 0.08s',
            },
            chipHover: {
                background: bgHover,
            },
            chipEditing: {
                background: bgHover,
            },
        }
    }

    private inputStyles(initialLen: number): Partial<CSSStyleDeclaration> {
        const t = getTheme(this.isDark)
        return {
            width: `${Math.max(4, initialLen + 1)}ch`,
            padding: '0',
            border: 'none',
            borderBottom: `0.1em solid ${t.network.edgeLabelText}`,
            borderRadius: '0',
            background: 'transparent',
            color: 'inherit',
            fontFamily: 'inherit',
            fontSize: 'inherit',
            lineHeight: 'inherit',
            outline: 'none',
        }
    }
}

/**
 * Apply an alpha multiplier to a hex colour, returning rgba(...).
 * Falls back to the original string if parsing fails.
 */
function withAlpha(hex: string, alpha: number): string {
    const m = hex.match(/^#?([0-9a-fA-F]{6})$/)
    if (!m) return hex
    const n = parseInt(m[1]!, 16)
    const r = (n >> 16) & 0xff
    const g = (n >> 8) & 0xff
    const b = n & 0xff
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function formatValue(v: number): string {
    if (!Number.isFinite(v)) return String(v)
    if (v === 0) return '0'
    const abs = Math.abs(v)
    if (abs >= 0.01 && abs < 1000) {
        return v.toFixed(4).replace(/\.?0+$/, '')
    }
    return v.toExponential(2)
}
