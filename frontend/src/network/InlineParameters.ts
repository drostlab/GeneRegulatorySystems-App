/**
 * InlineParameters - per-parameter DOM chips anchored to network elements.
 *
 * For each editable element (regulatory edge or reaction node) that exposes
 * a non-empty `data.parameters` array, this creates a container of small
 * chips, one per parameter. Each chip displays `name=value` (resolved
 * against the active model via the supplied `parameterLookup`) and can be
 * clicked to swap in a text input for inline editing.
 *
 * Positioning is done manually via `transform: translate3d` (GPU-composited)
 * driven by cytoscape's `renderedMidpoint()` / `renderedPosition()`. Earlier
 * versions used `cytoscape-popper` + `@popperjs/core`, but popper's modifier
 * pipeline became the dominant cost (43–75% of frame time during zoom in
 * large networks) with no real benefit — we don't use flip or
 * preventOverflow, just placement + a small offset, which are trivial.
 *
 * Visual style mirrors Cytoscape's canvas labels: same theme colours
 * (`edgeLabelText` / `edgeLabelBg`), Montserrat font, and scales with the
 * cytoscape zoom so chips track world space (font-size em-based; container
 * font-size = baseFontSize * zoom).
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
 */
const BASE_FONT_SIZE_PX: Record<string, number> = {
    activation: 7,
    repression: 7,
    proteolysis: 7,
    reaction: 1.4,
}
const SPECIES_VIEW_EDGE_FONT_SIZE = 2
const DEFAULT_BASE_FONT_SIZE_PX = 7

/** Screen-pixel gap between chip and its anchor (matches old popper offset). */
const ANCHOR_OFFSET_PX = 2

type Placement = 'top' | 'bottom'

interface Anchor {
    container: HTMLDivElement
    ele: any
    baseFontSize: number
    placement: Placement
}

export class InlineParameters {
    private cy: Core | null = null
    private anchors = new Map<string, Anchor>()
    private isDark = false

    private lookup: ParameterValueLookup = () => undefined
    private handler: ParameterChangeHandler | null = null

    /** Disabled for now — parameter editing is not yet wired to persist. */
    private editable = false

    private onAdd: ((evt: any) => void) | null = null
    private onRemove: ((evt: any) => void) | null = null
    private onViewportChange: (() => void) | null = null

    /** rAF id for the pending update, so multiple events coalesce to one frame. */
    private pendingFrame: number | null = null

    /**
     * Notified when the cursor enters or moves over a parameter chip.
     * `ele` is the underlying cytoscape element; `(clientX, clientY)` are
     * viewport coords for the shared GRS tooltip.
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

        cy.elements().forEach(el => this.maybeCreateAnchor(el))

        this.onAdd = (evt: any) => this.maybeCreateAnchor(evt.target)
        this.onRemove = (evt: any) => this.removeAnchor(String(evt.target.id()))

        // All position-affecting events coalesce into one rAF-batched update
        // per frame. `position` fires on every animated layout step too.
        this.onViewportChange = () => this.scheduleUpdate()

        cy.on('add', 'edge, node', this.onAdd)
        cy.on('remove', 'edge, node', this.onRemove)
        cy.on('pan zoom resize', this.onViewportChange)
        cy.on('position', 'node', this.onViewportChange)
        // `style` fires when classes are added/removed (e.g. SelectionSync
        // toggling `.dimmed`). Coalesced via rAF so a flurry of class
        // changes still costs one updateAll per frame.
        cy.on('style', this.onViewportChange)

        this.scheduleUpdate()
    }

    refreshValues(): void {
        for (const anchor of this.anchors.values()) {
            this.refreshAnchorValues(anchor)
        }
        this.scheduleUpdate()
    }

    applyTheme(isDark: boolean): void {
        this.isDark = isDark
        for (const anchor of this.anchors.values()) {
            const chips = anchor.container.querySelectorAll<HTMLElement>('.param-chip')
            chips.forEach(chip => {
                if (chip.dataset.editing === 'true') return
                Object.assign(chip.style, this.chipStyles().chipIdle)
            })
        }
    }

    /**
     * Called by NetworkView when AdaptiveZoom toggles species view, so chip
     * font-sizes pick up the smaller `.species-view` regulatory size.
     */
    notifyDetailChanged(): void {
        this.scheduleUpdate()
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
                this.cy.off('pan zoom resize', this.onViewportChange)
                this.cy.off('position', 'node', this.onViewportChange)
                this.cy.off('style', this.onViewportChange)
            }
        }
        for (const a of this.anchors.values()) a.container.remove()
        this.anchors.clear()
        this.cy = null
        this.onAdd = null
        this.onRemove = null
        this.onViewportChange = null
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

        const host = this.cy?.container() ?? document.body
        if (host) {
            if (getComputedStyle(host).position === 'static') {
                host.style.position = 'relative'
            }
            host.appendChild(container)
        }

        const placement: Placement =
            ele.isNode() && kind === 'reaction' ? 'bottom' : 'top'
        const baseFontSize = BASE_FONT_SIZE_PX[kind] ?? DEFAULT_BASE_FONT_SIZE_PX
        const anchor: Anchor = { container, ele, baseFontSize, placement }
        this.anchors.set(id, anchor)
        this.positionAnchor(anchor)
    }

    private removeAnchor(id: string): void {
        const a = this.anchors.get(id)
        if (!a) return
        a.container.remove()
        this.anchors.delete(id)
    }

    /** Coalesce position updates to one per animation frame. */
    private scheduleUpdate(): void {
        if (this.pendingFrame !== null) return
        this.pendingFrame = requestAnimationFrame(() => {
            this.pendingFrame = null
            this.updateAll()
        })
    }

    private updateAll(): void {
        if (!this.cy) return

        // See `endpointCompoundIds` below — we exclude an edge's own endpoint
        // gene compounds from the occlusion test so legitimate endpoints
        // (and self-regulation midpoints) don't hide their chips.
        const geneBoxes = this.cy.nodes('.gene')
            .filter((g: any) => typeof g.visible !== 'function' || g.visible())
            .map((g: any) => ({ id: String(g.id()), bb: g.renderedBoundingBox() }))

        for (const a of this.anchors.values()) {
            let visible = typeof a.ele.visible === 'function' ? a.ele.visible() : true

            if (
                visible
                && a.ele.isEdge?.()
                && typeof a.ele.renderedMidpoint === 'function'
            ) {
                const exclude = endpointCompoundIds(a.ele)
                const mid = a.ele.renderedMidpoint()
                for (const { id, bb } of geneBoxes) {
                    if (exclude.has(id)) continue
                    if (mid.x >= bb.x1 && mid.x <= bb.x2 && mid.y >= bb.y1 && mid.y <= bb.y2) {
                        visible = false
                        break
                    }
                }
            }

            if (!visible) {
                a.container.style.display = 'none'
                continue
            }
            a.container.style.display = 'flex'
            // Mirror the underlying element's `.dimmed` state on the chip
            // container — cytoscape selection dimming only touches the
            // canvas elements; the DOM chips need to follow manually.
            a.container.style.opacity = a.ele.hasClass?.('dimmed') ? '0.3' : '1'
            this.positionAnchor(a)
        }
    }

    /**
     * Position a single chip container. Cheap: one renderedMidpoint/Position
     * read and a transform write. `transform: translate3d` is GPU-composited
     * and doesn't trigger layout; only the font-size update triggers a
     * cheap text reflow inside the chip itself.
     */
    private positionAnchor(a: Anchor): void {
        if (!this.cy) return
        const ele = a.ele
        const pos = ele.isEdge?.()
            ? ele.renderedMidpoint?.()
            : ele.renderedPosition?.()
        if (!pos) return

        const zoom = this.cy.zoom()
        a.container.style.fontSize = `${this.effectiveBaseFontSize(a) * zoom}px`

        // Compose translate to anchor position + translate -50% horizontal
        // and -100%/0% vertical to align the chip's bottom/top edge with
        // the anchor (matches old popper placement: 'top'/'bottom').
        const verticalNudge = a.placement === 'top' ? -ANCHOR_OFFSET_PX : ANCHOR_OFFSET_PX
        const verticalAlign = a.placement === 'top' ? '-100%' : '+80%'
        a.container.style.transform =
            `translate3d(${pos.x.toFixed(1)}px, ${(pos.y + verticalNudge).toFixed(1)}px, 0) ` +
            `translate(-50%, ${verticalAlign})`
    }

    private effectiveBaseFontSize(anchor: Anchor): number {
        if (anchor.ele.isEdge?.() && anchor.ele.hasClass?.('species-view')) {
            return SPECIES_VIEW_EDGE_FONT_SIZE
        }
        return anchor.baseFontSize
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

        chip.addEventListener('mouseenter', e => {
            if (chip.dataset.editing === 'true') return
            Object.assign(chip.style, this.chipStyles().chipHover)
            this.fireChipHover(ele, e)
        })
        chip.addEventListener('mousemove', e => {
            if (chip.dataset.editing === 'true') return
            this.fireChipHover(ele, e)
        })
        chip.addEventListener('mouseleave', () => {
            if (chip.dataset.editing === 'true') return
            Object.assign(chip.style, this.chipStyles().chipIdle)
            this.onChipLeave?.()
        })
        chip.addEventListener('mousedown', e => e.stopPropagation())
        chip.addEventListener('click', e => {
            e.stopPropagation()
            if (!this.editable) return
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
            left: '0',
            top: '0',
            display: 'flex',
            gap: '0.3em',
            alignItems: 'center',
            pointerEvents: 'auto',
            zIndex: '50',
            fontFamily: 'Montserrat, sans-serif',
            fontSize: `${DEFAULT_BASE_FONT_SIZE_PX}px`,
            lineHeight: '1.2',
            willChange: 'transform',
        }
    }

    private chipStyles(): {
        chipIdle: Partial<CSSStyleDeclaration>
        chipHover: Partial<CSSStyleDeclaration>
        chipEditing: Partial<CSSStyleDeclaration>
    } {
        const t = getTheme(this.isDark)
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

/**
 * IDs of the gene compounds at each end of an edge — i.e. compounds whose
 * bbox naturally contains an endpoint and shouldn't be used as an
 * "occluding" compound in the chip hit-test.
 */
function endpointCompoundIds(edge: any): Set<string> {
    const result = new Set<string>()
    for (const end of [edge.source?.(), edge.target?.()]) {
        if (!end) continue
        const compound = end.isParent?.() ? end : end.parent?.()
        if (end.data?.('kind') === 'gene') result.add(String(end.id()))
        if (compound && compound.nonempty?.() && compound.data?.('kind') === 'gene') {
            result.add(String(compound.id()))
        }
    }
    return result
}
