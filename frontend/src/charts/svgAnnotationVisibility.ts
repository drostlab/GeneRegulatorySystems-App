/**
 * SVG Annotation Visibility
 *
 * SciChart SubSurface annotations are SVG DOM elements on the parent surface's
 * shared SVG layer. When SubSurface.isVisible = false, the render loop is
 * skipped so AnnotationBase.isHidden never takes effect (the SVG elements stay
 * frozen at their last position). This module provides direct DOM-level
 * show/hide as a workaround.
 */

import { SvgAnnotationBase, type AnnotationBase } from "scichart"


/** Set display:none on an SVG annotation's DOM element, bypassing the render loop. */
export function setSvgAnnotationVisible(ann: AnnotationBase, visible: boolean): void {
    ann.isHidden = !visible
    if (ann instanceof SvgAnnotationBase) {
        ann.svg.style.display = visible ? '' : 'none'
    }
}

/** Bulk show/hide a collection of SVG annotations. */
export function setSvgAnnotationsVisible(annotations: Iterable<AnnotationBase>, visible: boolean): void {
    for (const ann of annotations) {
        setSvgAnnotationVisible(ann, visible)
    }
}
