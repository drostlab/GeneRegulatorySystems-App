/** Centralised chart styling constants. */



export const CHART_FONT_SIZES = {
    label: 10,
    title: 12,
    annotation: 9
} as const

/**
 * Trailing-window capacity for live streaming data series. Each live (species,
 * path) series keeps at most this many points in WASM; older points fall off the
 * back of the FIFO. Bounds client memory during arbitrarily long live runs — the
 * full-resolution history lives on disk and is served via the adaptive viewport
 * query once the run finishes (the two regimes compose). Only the active branch is
 * streamed at a time, so this is a small trailing window per subscribed species —
 * deliberately small to avoid polluting WASM memory during long runs.
 */
export const STREAMING_FIFO_CAPACITY = 20_000

/** Default left-axis thickness (px). Counts panel uses a narrower value. */
export const AXIS_THICKNESS = 23
export const AXIS_THICKNESS_NARROW = 23

/** Default segment palette (light mode). Used where isDark is not available. */
