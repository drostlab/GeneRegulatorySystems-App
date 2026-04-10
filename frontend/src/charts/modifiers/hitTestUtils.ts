/**
 * Shared hit-test helpers for SciChart chart modifiers.
 *
 * Coordinates inside a modifier's `modifierMouseMove/Up` are already
 * DPI-premultiplied (see `ModifierMouseArgs.fromPointerEvent`), and
 * sub-surface-translated (see `copyForSubChart`).  Pass `this.mousePoint`
 * directly -- never multiply by `DpiHelper.PIXEL_RATIO` again.
 *
 * For sub-surface modifiers, always guard with:
 *   if (parentSurface.isSubSurface && !args.isActiveSubChartEvent) return;
 */
import { DpiHelper, type HitTestInfo, type IRenderableSeries, type Point } from "scichart"

/** Default hit-test radius in CSS pixels (scaled to physical pixels internally). */
const DEFAULT_HIT_TEST_RADIUS_CSS = 10

/**
 * Hit-test a single renderable series at the given (already-premultiplied)
 * mouse point.  Returns the HitTestInfo if the point is within `radiusCss`
 * CSS pixels of a data point, otherwise `null`.
 */
export function hitTestSeries(
    series: IRenderableSeries,
    mousePoint: Point,
    radiusCss: number = DEFAULT_HIT_TEST_RADIUS_CSS,
): HitTestInfo | null {
    const radius = radiusCss * DpiHelper.PIXEL_RATIO
    const info = series.hitTestProvider.hitTestDataPoint(
        mousePoint.x, mousePoint.y, radius,
    )
    return info.isHit ? info : null
}

/**
 * Find the nearest hit across multiple renderable series.
 * Returns `{ series, hitTestInfo }` for the closest hit, or `null`.
 */
export function hitTestNearest(
    seriesList: IRenderableSeries[],
    mousePoint: Point,
    radiusCss: number = DEFAULT_HIT_TEST_RADIUS_CSS,
): { series: IRenderableSeries; hitTestInfo: HitTestInfo } | null {
    const radius = radiusCss * DpiHelper.PIXEL_RATIO
    let bestDist = Infinity
    let bestResult: { series: IRenderableSeries; hitTestInfo: HitTestInfo } | null = null

    for (const rs of seriesList) {
        const info = rs.hitTestProvider.hitTestDataPoint(
            mousePoint.x, mousePoint.y, radius,
        )
        if (info.isHit && info.distance < bestDist) {
            bestDist = info.distance
            bestResult = { series: rs, hitTestInfo: info }
        }
    }
    return bestResult
}

/**
 * Guard for sub-surface modifiers.  Returns `true` if the event should
 * be processed, `false` if it belongs to a different sub-surface.
 *
 * Usage:
 *   if (!shouldProcessEvent(this.parentSurface, args)) return;
 */
export function shouldProcessEvent(
    parentSurface: { isSubSurface?: boolean },
    args: { isActiveSubChartEvent?: boolean },
): boolean {
    if (parentSurface.isSubSurface && !args.isActiveSubChartEvent) return false
    return true
}
