/**
 * Canvas-based chart export.
 *
 * Composites all canvas elements inside a SciChart root div onto a single
 * output canvas and returns it as a Blob. This bypasses html-to-image's
 * SVG foreignObject pipeline, which fails in WKWebView (Tauri on macOS)
 * because canvas elements render blank inside foreignObject.
 */

import logging from '@/utils/logging'

const logger = logging.getLogger('canvasExport')

const PIXEL_RATIO = 8

/**
 * Render all visible canvases within `root` to a single composited PNG Blob.
 * Falls back to null if compositing fails (caller should handle fallback).
 */
export function compositCanvasesToBlob(root: HTMLDivElement): Promise<Blob | null> {
    const { width, height } = root.getBoundingClientRect()
    if (width === 0 || height === 0) {
        logger.debug('Root element has zero dimensions, skipping canvas export')
        return Promise.resolve(null)
    }

    const outCanvas = document.createElement('canvas')
    outCanvas.width = Math.round(width * PIXEL_RATIO)
    outCanvas.height = Math.round(height * PIXEL_RATIO)

    const ctx = outCanvas.getContext('2d')!
    ctx.scale(PIXEL_RATIO, PIXEL_RATIO)

    // Fill with the root's background colour (usually the chart theme bg)
    const rootStyle = getComputedStyle(root)
    ctx.fillStyle = rootStyle.backgroundColor || '#ffffff'
    ctx.fillRect(0, 0, width, height)

    const rootRect = root.getBoundingClientRect()
    const canvases = root.querySelectorAll('canvas')

    logger.debug(`Compositing ${canvases.length} canvases (${width}x${height} @ ${PIXEL_RATIO}x)`)

    for (const canvas of canvases) {
        if (canvas.width === 0 || canvas.height === 0) continue
        const canvasRect = canvas.getBoundingClientRect()
        const x = canvasRect.left - rootRect.left
        const y = canvasRect.top - rootRect.top
        ctx.drawImage(canvas, x, y, canvasRect.width, canvasRect.height)
    }

    return new Promise<Blob | null>(resolve => {
        outCanvas.toBlob(blob => resolve(blob), 'image/png')
    })
}
