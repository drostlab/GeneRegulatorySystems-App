/**
 * Drives smooth axis animation during simulation streaming.
 *
 * Decouples data ingestion speed from visual presentation: data is appended
 * to SciChart as fast as it arrives, but the visible x/y ranges lerp smoothly
 * toward their targets using frame-rate-independent exponential easing.
 *
 * Usage:
 *   const animator = new StreamingAnimator(applyRanges)
 *   animator.start()
 *   // on each data flush:
 *   animator.setTargetX(currentTime)
 *   animator.setTargetY(panelId, yMin, yMax)
 *   // on simulation complete:
 *   animator.stop()
 */

/** Per-panel y-range target. */
interface YTarget {
    min: number
    max: number
    /** Currently displayed values (lerped). */
    displayMin: number
    displayMax: number
}

export interface RangeUpdate {
    xMin: number
    xMax: number
    yRanges: Map<string, { min: number; max: number }>
}

/**
 * Default exponential-decay smoothing factor (units: 1/second).
 * Higher = faster tracking. At 8/s, ~90% convergence in ~0.3s.
 */
const DEFAULT_SMOOTH_SPEED = 8

/**
 * When the displayed value is within this fraction of the target,
 * snap to exact value to avoid endless micro-updates.
 */
const SNAP_THRESHOLD = 0.001

export class StreamingAnimator {
    private rafId: number | null = null
    private lastFrameTime: number | null = null
    private running = false

    /** Adaptive smoothing speed (1/second). */
    private smoothSpeed = DEFAULT_SMOOTH_SPEED

    /** Target x-range (always starts at 0). */
    private targetXMax = 0
    private displayXMax = 0

    /** Per-panel y targets. */
    private yTargets = new Map<string, YTarget>()

    /** Called each frame with the interpolated ranges. */
    private onUpdate: (update: RangeUpdate) => void

    constructor(onUpdate: (update: RangeUpdate) => void) {
        this.onUpdate = onUpdate
    }

    start(): void {
        if (this.running) return
        this.running = true
        this.lastFrameTime = null
        this.targetXMax = 0
        this.displayXMax = 0
        this.smoothSpeed = DEFAULT_SMOOTH_SPEED
        this.yTargets.clear()
        console.debug('[StreamingAnimator] started')
        this._tick()
    }

    stop(): void {
        this.running = false
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId)
            this.rafId = null
        }
        this.lastFrameTime = null
        console.debug('[StreamingAnimator] stopped')
    }

    /** Update the target x-max (simulation current time). */
    setTargetX(xMax: number): void {
        if (xMax > this.targetXMax) {
            this.targetXMax = xMax
        }
    }

    /**
     * Set the smoothing speed (1/second).
     * Derived from the inter-batch interval so 95% convergence
     * happens in roughly one batch period: speed = -ln(0.05) / interval.
     */
    setSpeed(speed: number): void {
        this.smoothSpeed = Math.max(1, Math.min(speed, 30))
    }

    /** Update the target y-range for a specific panel. */
    setTargetY(panelId: string, yMin: number, yMax: number): void {
        const existing = this.yTargets.get(panelId)
        if (existing) {
            existing.min = yMin
            existing.max = yMax
        } else {
            // First time seeing this panel — snap display to target immediately
            this.yTargets.set(panelId, {
                min: yMin,
                max: yMax,
                displayMin: yMin,
                displayMax: yMax,
            })
        }
    }

    private _tick(): void {
        if (!this.running) return

        this.rafId = requestAnimationFrame((now) => {
            if (!this.running) return

            const dt = this.lastFrameTime !== null
                ? Math.min((now - this.lastFrameTime) / 1000, 0.1) // cap at 100ms to avoid jumps after tab switch
                : 0 // first frame: no interpolation, just set up
            this.lastFrameTime = now

            // Exponential ease: factor = 1 - e^(-speed * dt)
            // At 60fps (dt≈0.016): factor ≈ 0.12
            // At 30fps (dt≈0.033): factor ≈ 0.23
            const factor = 1 - Math.exp(-this.smoothSpeed * dt)

            // Lerp x-axis
            this.displayXMax = this._lerp(this.displayXMax, this.targetXMax, factor)

            // Lerp y-axes
            const yRanges = new Map<string, { min: number; max: number }>()
            for (const [panelId, yt] of this.yTargets) {
                yt.displayMin = this._lerp(yt.displayMin, yt.min, factor)
                yt.displayMax = this._lerp(yt.displayMax, yt.max, factor)
                yRanges.set(panelId, { min: yt.displayMin, max: yt.displayMax })
            }

            // Only call update if we have a meaningful x range
            if (this.displayXMax > 0) {
                this.onUpdate({
                    xMin: 0,
                    xMax: this.displayXMax,
                    yRanges,
                })
            }

            this._tick()
        })
    }

    /**
     * Lerp with snap: if close enough to target, snap exactly.
     * Avoids endless micro-updates from exponential decay never reaching zero.
     */
    private _lerp(current: number, target: number, factor: number): number {
        const diff = target - current
        if (Math.abs(diff) < SNAP_THRESHOLD * Math.max(1, Math.abs(target))) {
            return target
        }
        return current + diff * factor
    }
}
