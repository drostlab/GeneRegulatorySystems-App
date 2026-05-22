/**
 * v-grs-tooltip directive — shows a DOM tooltip on hover using the shared
 * .grs-tooltip style, consistent with Cytoscape node/edge and timeline tooltips.
 *
 * Usage:  <Button v-grs-tooltip="'Some text'" />
 */
import type { Directive } from 'vue'

type Handlers = {
    enter: (e: MouseEvent) => void
    move: (e: MouseEvent) => void
    leave: () => void
}

let tooltipEl: HTMLDivElement | null = null
const handlerMap = new WeakMap<HTMLElement, Handlers>()

function getTooltip(): HTMLDivElement {
    if (!tooltipEl) {
        tooltipEl = document.createElement('div')
        tooltipEl.className = 'grs-tooltip'
        tooltipEl.style.display = 'none'
        tooltipEl.style.position = 'fixed'
        tooltipEl.style.pointerEvents = 'none'
        tooltipEl.style.zIndex = '9999'
        document.body.appendChild(tooltipEl)
    }
    return tooltipEl
}

function placeAt(clientX: number, clientY: number): void {
    const el = getTooltip()
    const margin = 16
    const tooltipWidth = el.offsetWidth || 120
    const nearRight = clientX + tooltipWidth + margin > window.innerWidth
    el.style.left = nearRight
        ? `${clientX - tooltipWidth - 8}px`
        : `${clientX + 12}px`
    el.style.top = `${clientY - 20}px`
}

function showTooltip(e: MouseEvent, text: string): void {
    showGrsTooltip(text, e.clientX, e.clientY)
}

function moveTooltip(e: MouseEvent): void {
    placeAt(e.clientX, e.clientY)
}

function hideTooltip(): void {
    getTooltip().style.display = 'none'
}

/**
 * Imperative API for showing the shared GRS tooltip from non-directive
 * call sites (e.g. Cytoscape event handlers, which operate on cytoscape
 * elements rather than DOM nodes).
 */
export function showGrsTooltip(text: string, clientX: number, clientY: number): void {
    const el = getTooltip()
    el.textContent = text
    el.style.display = 'block'
    placeAt(clientX, clientY)
}

export function moveGrsTooltip(clientX: number, clientY: number): void {
    placeAt(clientX, clientY)
}

export function hideGrsTooltip(): void {
    hideTooltip()
}

function attachHandlers(el: HTMLElement, text: string): void {
    removeHandlers(el)
    const handlers: Handlers = {
        enter: (e) => showTooltip(e, text),
        move: moveTooltip,
        leave: hideTooltip,
    }
    handlerMap.set(el, handlers)
    el.addEventListener('mouseenter', handlers.enter)
    el.addEventListener('mousemove', handlers.move)
    el.addEventListener('mouseleave', handlers.leave)
}

function removeHandlers(el: HTMLElement): void {
    const handlers = handlerMap.get(el)
    if (!handlers) return
    el.removeEventListener('mouseenter', handlers.enter)
    el.removeEventListener('mousemove', handlers.move)
    el.removeEventListener('mouseleave', handlers.leave)
    handlerMap.delete(el)
}

export const grsTooltip: Directive<HTMLElement, string> = {
    mounted: (el, binding) => attachHandlers(el, binding.value),
    updated: (el, binding) => attachHandlers(el, binding.value),
    unmounted: (el) => { hideTooltip(); removeHandlers(el) },
}
