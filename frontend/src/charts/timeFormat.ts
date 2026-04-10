/**
 * Adaptive time formatting for SciChart axes and tooltips.
 *
 * Converts raw seconds into the most readable unit (seconds, minutes, hours,
 * days, months, years) based on the magnitude of the value.
 */

import type { NumericAxis } from "scichart"

interface TimeUnit {
    label: string
    seconds: number
}

const TIME_UNITS: TimeUnit[] = [
    { label: "y",   seconds: 365.25 * 24 * 3600 },
    { label: "mo",  seconds: 30.4375 * 24 * 3600 },
    { label: "d",   seconds: 24 * 3600 },
    { label: "h",   seconds: 3600 },
    { label: "min", seconds: 60 },
    { label: "s",   seconds: 1 },
]

/**
 * Pick the best unit for a given value in seconds.
 * Chooses the largest unit where the converted value is >= 1.
 */
function pickUnit(seconds: number): TimeUnit {
    const abs = Math.abs(seconds)
    for (const unit of TIME_UNITS) {
        if (abs >= unit.seconds) return unit
    }
    return TIME_UNITS[TIME_UNITS.length - 1]!
}

/**
 * Determine appropriate decimal precision for a converted value.
 * Large values get fewer decimals; small values get more.
 */
function autoPrecision(value: number): number {
    const abs = Math.abs(value)
    if (abs >= 100) return 0
    if (abs >= 10) return 1
    if (abs >= 1) return 2
    return 3
}

/**
 * Format a time value (in seconds) as a human-readable string.
 * E.g. 86400 -> "1 d", 7200 -> "2 h", 90 -> "1.5 min".
 */
export function formatTime(seconds: number): string {
    if (seconds === 0) return "0 s"
    const unit = pickUnit(seconds)
    const converted = seconds / unit.seconds
    const precision = autoPrecision(converted)
    return `${converted.toFixed(precision)} ${unit.label}`
}

/**
 * Attach adaptive time formatting to a time x-axis.
 *
 * - Picks a single consistent unit based on the visible range, so all tick
 *   labels share the same unit (e.g. all in hours).
 * - Updates the axis title to "Time (hours)" etc. whenever the range changes.
 * - Returns an unsubscribe function to call on panel dispose.
 */
export function setupTimeAxis(xAxis: NumericAxis): () => void {
    let currentUnit: TimeUnit = TIME_UNITS[TIME_UNITS.length - 1]!

    const updateUnit = (maxAbs: number): void => {
        currentUnit = pickUnit(maxAbs)
        xAxis.axisTitle = 'Time'
    }

    xAxis.labelProvider.formatLabel = (dataValue: number) => {
        const converted = dataValue / currentUnit.seconds
        return `${converted.toFixed(autoPrecision(converted))} ${currentUnit.label}`
    }

    xAxis.labelProvider.formatCursorLabel = (dataValue: number) => formatTime(dataValue)

    const onRangeChanged = (args?: { visibleRange: { min: number; max: number } }): void => {
        if (!args) return
        const maxAbs = Math.max(Math.abs(args.visibleRange.min), Math.abs(args.visibleRange.max))
        updateUnit(maxAbs)
    }

    xAxis.visibleRangeChanged.subscribe(onRangeChanged)

    // Seed from current range if available
    const initial = xAxis.visibleRange
    if (initial) {
        updateUnit(Math.max(Math.abs(initial.min), Math.abs(initial.max)))
    }

    return () => xAxis.visibleRangeChanged.unsubscribe(onRangeChanged)
}
