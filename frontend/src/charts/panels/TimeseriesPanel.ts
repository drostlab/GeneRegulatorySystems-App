import { BasePanel, type BasePanelOptions } from "./BasePanel";
import { TimeseriesHoverModifier } from "../modifiers/TimeseriesHoverModifier";
import type { TimeseriesData, TimeseriesMetadata } from "@/types/simulation";

export type PathTimeRanges = Map<string, { from: number; to: number }>

export abstract class TimeseriesPanel extends BasePanel {
    protected metadata: TimeseriesMetadata | null = null
    protected pathTimeRanges: PathTimeRanges = new Map()

    private hoverModifier: TimeseriesHoverModifier

    constructor(options: BasePanelOptions) {
        super(options)
        this.hoverModifier = new TimeseriesHoverModifier()
        this.surface.chartModifiers.add(this.hoverModifier)
    }

    override dispose(): void {
        this.hoverModifier.dispose()
        super.dispose()
    }

    /** Register a callback fired with the execution path on hover (null on leave). */
    onPathHover(cb: (path: string | null) => void): void {
        this.hoverModifier.onPathHover(cb)
    }

    /** Register a callback fired with the gene id on hover (null on leave). */
    onGeneHover(cb: (gene: string | null) => void): void {
        this.hoverModifier.onGeneHover(cb)
    }

    setMetadata(metadata: TimeseriesMetadata | null): void {
        this.metadata = metadata
    }

    setPathTimeRanges(ranges: PathTimeRanges): void {
        this.pathTimeRanges = ranges
    }

    abstract setData(timeseries: TimeseriesData, opts?: { animate?: boolean }): void

}
