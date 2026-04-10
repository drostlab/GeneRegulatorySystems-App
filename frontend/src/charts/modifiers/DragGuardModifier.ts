/**
 * Tracks mouse movement between mouseDown and mouseMove to distinguish
 * clicks from drags. Other code can check `isDrag` to skip selection
 * when the user was panning.
 *
 * Must be added BEFORE SeriesSelectionModifier in the modifier list so
 * that `isDrag` is up-to-date when `onSelectedChanged` fires.
 */
import { ChartModifierBase2D, EChart2DModifierType, type ModifierMouseArgs } from "scichart"

const DRAG_THRESHOLD_PX = 5

export class DragGuardModifier extends ChartModifierBase2D {
    readonly type = EChart2DModifierType.Custom
    isDrag = false
    private startX = 0
    private startY = 0

    modifierMouseDown(args: ModifierMouseArgs): void {
        super.modifierMouseDown(args)
        this.startX = args.mousePoint.x
        this.startY = args.mousePoint.y
        this.isDrag = false
    }

    modifierMouseMove(args: ModifierMouseArgs): void {
        super.modifierMouseMove(args)
        if (!this.isDrag) {
            const dx = Math.abs(args.mousePoint.x - this.startX)
            const dy = Math.abs(args.mousePoint.y - this.startY)
            if (dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX) {
                this.isDrag = true
            }
        }
    }
}
