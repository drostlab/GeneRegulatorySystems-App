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

function place(e: MouseEvent): void {
    const el = getTooltip()
    const margin = 16
    const tooltipWidth = el.offsetWidth || 120
    const nearRight = e.clientX + tooltipWidth + margin > window.innerWidth
    el.style.left = nearRight
        ? `${e.clientX - tooltipWidth - 8}px`
        : `${e.clientX + 12}px`
    el.style.top = `${e.clientY - 20}px`
}

function showTooltip(e: MouseEvent, text: string): void {
    const el = getTooltip()
    el.textContent = text
    el.style.display = 'block'
    place(e)
}

function moveTooltip(e: MouseEvent): void {
    place(e)
}

function hideTooltip(): void {
    getTooltip().style.display = 'none'
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
