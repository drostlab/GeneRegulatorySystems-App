/**
 * ChartLayout -- recursive tree-based layout engine for SciChart sub-surfaces.
 *
 * Replaces SubChartLayoutModifier. Instead of a flat list, the layout is
 * described by a tree of LayoutNodes:
 *   - 'group' leaf: renders all visible panels of a PanelGroup stacked vertically
 *   - 'split': divides space between two children (horizontal or vertical)
 *
 * Attach to a parent SciChartSurface via `attach(surface)`.
 * Call `updateLayout()` whenever panel visibility or tree structure changes.
 */
import { Rect, SciChartVerticalGroup, type SciChartSurface, type SciChartSubSurface } from "scichart"
import type { PanelGroup } from "./PanelGroup"

/** Minimum / maximum y-axis title font size (px). */
const MIN_TITLE_FONT = 7
const MAX_TITLE_FONT = 14
/** Fraction of panel pixel height used for axis title font scaling. */
const TITLE_FONT_SCALE = 0.046


// ---------------------------------------------------------------------------
// Layout tree types
// ---------------------------------------------------------------------------

export interface GroupNode {
    kind: 'group'
    group: PanelGroup
    /** Label shown on the bottom panel's x-axis (e.g. "Time"). Empty string to hide. */
    xAxisLabel: string
}

export interface SplitNode {
    kind: 'split'
    direction: 'horizontal' | 'vertical'
    /** Fraction [0,1] of space allocated to child `a`. */
    ratio: number
    a: LayoutNode
    b: LayoutNode
}

export type LayoutNode = GroupNode | SplitNode


// ---------------------------------------------------------------------------
// ChartLayout
// ---------------------------------------------------------------------------

export class ChartLayout {
    private surface: SciChartSurface | null = null
    private root: LayoutNode | null = null
    /** One SciChartVerticalGroup per PanelGroup for y-axis width alignment. */
    private verticalGroups = new Map<string, SciChartVerticalGroup>()
    /** Track which surfaces are already in a vertical group. */
    private groupedSurfaces = new Map<string, Set<object>>()
    private onResized = () => this.updateLayout()

    attach(surface: SciChartSurface): void {
        this.surface = surface
        this.surface.resized.subscribe(this.onResized)
    }

    detach(): void {
        this.surface?.resized.unsubscribe(this.onResized)
        this.surface = null
    }

    setRoot(root: LayoutNode): void {
        this.root = root
        this.updateLayout()
    }

    getRoot(): LayoutNode | null {
        return this.root
    }

    updateLayout(): void {
        if (!this.surface || !this.root) return
        this._layoutNode(this.root, 0, 0, 1, 1)
        this._scaleFonts()
    }

    dispose(): void {
        this.detach()
        this.verticalGroups.clear()
        this.groupedSurfaces.clear()
        this.root = null
    }

    // ------------------------------------------------------------------
    // Recursive layout
    // ------------------------------------------------------------------

    private _layoutNode(node: LayoutNode, x: number, y: number, w: number, h: number): void {
        if (node.kind === 'group') {
            this._layoutGroup(node, x, y, w, h)
        } else {
            this._layoutSplit(node, x, y, w, h)
        }
    }

    private _layoutSplit(node: SplitNode, x: number, y: number, w: number, h: number): void {
        if (node.direction === 'horizontal') {
            const wA = w * node.ratio
            const wB = w - wA
            this._layoutNode(node.a, x, y, wA, h)
            this._layoutNode(node.b, x + wA, y, wB, h)
        } else {
            const hA = h * node.ratio
            const hB = h - hA
            this._layoutNode(node.a, x, y, w, hA)
            this._layoutNode(node.b, x, y + hA, w, hB)
        }
    }

    private _layoutGroup(node: GroupNode, x: number, y: number, w: number, h: number): void {
        const group = node.group
        const visiblePanels = group.allPanels.filter(p => p.isVisible)
        const n = visiblePanels.length

        // Hide all non-visible surfaces in this group
        for (const panel of group.allPanels) {
            if (!panel.isVisible) {
                panel.surface.subPosition = new Rect(0, 0, 0, 0)
            }
        }

        if (n === 0) return

        // Ensure vertical group exists for this PanelGroup
        const vGroup = this._getOrCreateVerticalGroup(group.id)
        const grouped = this._getOrCreateGroupedSet(group.id)

        // Give bottom panel slightly more space for x-axis labels
        const extraSpace = n > 1 ? 0.075 * h : 0
        const baseHeight = (h - extraSpace) / n
        const lastHeight = baseHeight + extraSpace

        let currentY = y
        visiblePanels.forEach((panel, i) => {
            const sc = panel.surface
            if (!grouped.has(sc)) {
                vGroup.addSurfaceToGroup(sc)
                grouped.add(sc)
            }

            const isBottom = i === n - 1
            const panelH = isBottom ? lastHeight : baseHeight
            sc.subPosition = new Rect(x, currentY, w, panelH)
            currentY += panelH

            // Only show x-axis on the bottom panel of the group
            const xAxis = sc.xAxes.get(0)
            if (xAxis) {
                xAxis.drawLabels = isBottom
                // Only override axisTitle if the group specifies one;
                // otherwise preserve the panel's own title (e.g. PCA labels)
                if (node.xAxisLabel) {
                    xAxis.axisTitle = isBottom ? node.xAxisLabel : ""
                } else if (!isBottom) {
                    xAxis.axisTitle = ""
                }
                xAxis.isVisible = isBottom
            }
        })
    }

    // ------------------------------------------------------------------
    // Font scaling
    // ------------------------------------------------------------------

    /** Adapt y-axis title font size to absolute panel pixel height across all groups. */
    private _scaleFonts(): void {
        if (!this.surface) return
        const parentHeight = this.surface.renderSurface?.viewportSize?.height ?? 0
        if (parentHeight <= 0) return

        this._scaleFontsForNode(this.root!, parentHeight)
    }

    private _scaleFontsForNode(node: LayoutNode, parentHeight: number): void {
        if (node.kind === 'group') {
            const visiblePanels = node.group.allPanels.filter(p => p.isVisible)
            for (const panel of visiblePanels) {
                const pos = panel.surface.subPosition
                if (!pos) continue
                // subPosition is a Rect with .height, but TS union type includes TLtrbCoordinates.
                // We always set Rect ourselves, so cast is safe.
                const panelHeightPx = (pos as Rect).height * parentHeight
                const fontSize = Math.round(
                    Math.max(MIN_TITLE_FONT, Math.min(MAX_TITLE_FONT, panelHeightPx * TITLE_FONT_SCALE))
                )
                for (const yAxis of panel.surface.yAxes.asArray()) {
                    yAxis.axisTitleStyle = { ...yAxis.axisTitleStyle, fontSize }
                }
            }
        } else {
            this._scaleFontsForNode(node.a, parentHeight)
            this._scaleFontsForNode(node.b, parentHeight)
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private _getOrCreateVerticalGroup(groupId: string): SciChartVerticalGroup {
        let vg = this.verticalGroups.get(groupId)
        if (!vg) {
            vg = new SciChartVerticalGroup()
            this.verticalGroups.set(groupId, vg)
        }
        return vg
    }

    private _getOrCreateGroupedSet(groupId: string): Set<object> {
        let s = this.groupedSurfaces.get(groupId)
        if (!s) {
            s = new Set()
            this.groupedSurfaces.set(groupId, s)
        }
        return s
    }

    /**
     * Remove a surface from its vertical group tracking when a panel is removed.
     * Called by MainChart when removing panels.
     */
    removeFromVerticalGroup(groupId: string, surface: SciChartSubSurface): void {
        const vg = this.verticalGroups.get(groupId)
        const grouped = this.groupedSurfaces.get(groupId)
        if (vg && grouped?.has(surface)) {
            vg.removeSurface(surface)
            grouped.delete(surface)
        }
    }
}
