/**
 * Cytoscape style definitions for the network diagram.
 *
 * Node shapes:
 *   - gene: round-rectangle (compound parent when species visible)
 *   - species: ellipse (child of gene compound)
 *   - reaction: small dot, shows rate label
 *   - orphan species (no gene parent): circle, bigger than child species
 *
 * CSS classes:
 *   - `.excluded`: hidden via display:none (ModelFilter)
 *   - `.dimmed`: low opacity (SelectionSync)
 *   - `.highlighted`: bold border (SelectionSync)
 *   - `.species-view`: applied to regulatory edges when in species view
 *   - `.compound-parent`: applied to gene nodes with visible children
 *   - `.loop`: self-loop edge styling
 */

import {
    EDGE_COLOURS as THEME_EDGE_COLOURS,
    EDGE_COLOUR_FALLBACK,
    DIM_OPACITY as THEME_DIM_OPACITY,
    RED,
    getTheme,
} from '@/config/theme'

const FONT_FAMILY = 'Montserrat'

/**
 * Shared gene-label typography. Single source of truth for both the canvas
 * stylesheet (`node.gene` rules below) and the DOM overlay used by
 * InlineRename so the inline rename input is pixel-faithful to the label it
 * replaces.
 *
 *   compoundMarginY  -- matches the `text-margin-y` applied to compound
 *                       parents (label sits this many MODEL pixels above
 *                       the bbox top; multiply by zoom for rendered).
 */
export const GENE_LABEL_STYLE = {
    fontFamily: FONT_FAMILY,
    fontSize: 16,
    compoundMarginY: -8,
}

/**
 * Reaction-node label typography, shared by the `node.reaction` stylesheet
 * rule and the InlineRename overlay so a reaction rename input matches its
 * (small, centred) canvas label.
 */
export const REACTION_LABEL_STYLE = {
    fontFamily: FONT_FAMILY,
    fontSize: 2.1,
}

/**
 * Stoichiometry label typography on substrate/product edges, shared by those
 * edge rules and the InlineEdgeNumber overlay used to edit the number.
 */
export const STOICH_LABEL_STYLE = {
    fontFamily: FONT_FAMILY,
    fontSize: 1.3,
}

/** Edge colours re-exported from theme for backward compat. */
export const EDGE_COLOURS = THEME_EDGE_COLOURS

/** Gene node base dimensions. */
export const GENE_BASE = { width: 120, height: 50 }

/** Kronecker gene node dimensions (circle). */
export const KRONECKER_SIZE = 3
/** Timer gene node dimensions (circle, slightly larger than kronecker, dashed border). */
export const TIMER_SIZE = 20
/** Opacity for peripheral (Kronecker) nodes and edges. */
export const PERIPHERAL_OPACITY = 0.5

/** Min/max compound-node padding for dynamic sizing in species view. */
export const COMPOUND_PADDING_RANGE = { min: 6, max: 40 }

/** Species node size (small enough to fit inside gene in tight grid). */
export const SPECIES_SIZE = 8

/** Orphan species size (circle, bigger than child species). */
export const ORPHAN_SPECIES_SIZE = 30

/** Reaction node size. */
export const REACTION_SIZE = 7

/** Opacity for dimmed (unselected / excluded) elements. */
export const DIM_OPACITY = THEME_DIM_OPACITY

export function getEdgeColour(kind: string): string {
    return EDGE_COLOURS[kind] ?? EDGE_COLOUR_FALLBACK
}

export function shouldShowEdgeLabel(_kind: string): boolean {
    return true
}

/**
 * Default Cytoscape stylesheet.
 */
export function buildStylesheet(isDark = false): any[] {
    const t = getTheme(isDark)
    return [
        // -- base node (no borders) --
        // `label` and `background-color` are scoped with `[field]` selectors
        // so they only apply to elements that actually carry those data
        // attributes. Cytoscape warns when `mapData(...)` resolves against
        // an element missing the field — bare preview edges from
        // edgehandles trigger those warnings on every draw otherwise.
        {
            selector: 'node[label]',
            style: { 'label': 'data(label)' } as any,
        },
        {
            selector: 'node[colour]',
            style: { 'background-color': 'data(colour)' } as any,
        },
        {
            selector: 'node',
            style: {
                'text-valign': 'center' as any,
                'text-halign': 'center' as any,
                'font-size': 3,
                'font-family': FONT_FAMILY,
                'border-width': 0,
                'text-wrap': 'ellipsis' as any,
                'text-max-width': '120px',
            } as any,
        },
        // -- gene node: label always dark (label is inside the coloured box) --
        {
            selector: 'node.gene',
            style: {
                'shape': 'round-rectangle',
                'width': GENE_BASE.width,
                'height': GENE_BASE.height,
                'text-valign': 'center' as any,
                'font-size': GENE_LABEL_STYLE.fontSize,
                'padding': '6px',
                'min-width': `${GENE_BASE.width}px`,
                'min-height': `${GENE_BASE.height}px`,
            } as any,
        },
        {
            selector: 'node.gene[textColour]',
            style: { 'color': 'data(textColour)' } as any,
        },
        // -- compound gene (label above box): mode-aware colour, no ellipsis --
        // Fully opaque bg using a lightened (light mode) / darkened (dark mode)
        // version of the gene colour, so edges at low z visibly pass behind
        // compounds instead of bleeding through a 25%-transparent box.
        //
        // Compound depth left as `auto`: compound's effective z is
        // `min(children z) - 1` = -1 (children default to 0). Species-view
        // regulatory edges sit well below at z=-100, so they reliably draw
        // beneath any compound they cross. Going with orphan would put the
        // compound bg on top of its own species/reaction children — bad.
        {
            selector: 'node.compound-parent',
            style: {
                'text-valign': 'top' as any,
                'text-margin-y': GENE_LABEL_STYLE.compoundMarginY,
                'background-opacity': 1,
                'text-wrap': 'none' as any,
                'text-max-width': '9999px',
                'color': t.network.geneLabelText,
            } as any,
        },
        {
            selector: 'node.compound-parent[compoundColour]',
            style: { 'background-color': 'data(compoundColour)' } as any,
        },
        // -- kronecker (peripheral) gene: tiny circle, no label --
        {
            selector: 'node.gene[model_kind = "kronecker"]',
            style: {
                'shape': 'ellipse',
                'width': KRONECKER_SIZE,
                'height': KRONECKER_SIZE,
                'font-size': 7,
                'min-width': `${KRONECKER_SIZE}px`,
                'min-height': `${KRONECKER_SIZE}px`,
                'opacity': PERIPHERAL_OPACITY,
            } as any,
        },
        // -- timer gene: small circle, dashed border, slightly larger than kronecker --
        {
            selector: 'node.gene[model_kind = "timer"]',
            style: {
                'shape': 'ellipse',
                'width': TIMER_SIZE,
                'height': TIMER_SIZE,
                'font-size': 7,
                'min-width': `${TIMER_SIZE}px`,
                'min-height': `${TIMER_SIZE}px`,
            } as any,
        },
        {
            selector: 'node.gene[model_kind = "timer"][nodeColour]',
            style: {
                'border-color': 'data(nodeColour)'
            } as any,
        },
        // -- orphan species (shown at gene level, circle) --
        {
            selector: 'node.orphan-species',
            style: {
                'shape': 'ellipse',
                'width': ORPHAN_SPECIES_SIZE,
                'height': ORPHAN_SPECIES_SIZE,
                'font-size': 8,
                'color': t.network.speciesEdgeLabelText,
            } as any,
        },
        // -- species (child of gene compound) --
        {
            selector: 'node.species',
            style: {
                'shape': 'ellipse',
                'width': SPECIES_SIZE,
                'height': SPECIES_SIZE,
                'font-size': 2.4,
                'text-valign': 'bottom' as any,
                'text-margin-y': 1,
                'color': t.network.edgeLabelText,
            } as any,
        },
        // -- reaction (small dot with rate label) --
        {
            selector: 'node.reaction',
            style: {
                'shape': 'ellipse',
                'width': REACTION_SIZE,
                'height': REACTION_SIZE,
                'font-size': REACTION_LABEL_STYLE.fontSize,
                'text-valign': 'center' as any,
                'text-background-opacity': 0.8,
                'text-background-padding': '0.2px',
                'text-background-color': t.network.reactionBg,
                'background-color': t.network.reactionBg,
                'background-opacity': 0,
                'color': t.network.edgeLabelText,
            } as any,
        },
        {
            selector: 'node.reaction[rateName]',
            style: { 'label': 'data(rateName)' } as any,
        },
        {
            selector: 'node.reaction[parentColour]',
            style: { 'text-background-color': 'data(parentColour)' } as any,
        },
        // -- excluded (hidden by ModelFilter) --
        {
            selector: '.excluded',
            style: {
                'display': 'none',
            } as any,
        },
        // -- dimmed nodes --
        {
            selector: 'node.dimmed',
            style: {
                'opacity': DIM_OPACITY,
            } as any,
        },
        // -- highlighted gene (no border, just z-index boost) --
        {
            selector: 'node.highlighted',
            style: {
                'z-index': 10,
            } as any,
        },
        // -- gene hover (from timeseries panel hover) --
        {
            selector: 'node.gene-hover',
            style: {
                'border-width': 2,
                'border-color': RED[400],
                'z-index': 10,
            } as any,
        },
        // -- edges (base style) --
        // Same `[field]` scoping as nodes — bare edges (e.g. edgehandles
        // previews before we stamp `kind` data) shouldn't trigger mapData
        // warnings.
        {
            selector: 'edge[label]',
            style: { 'label': 'data(label)' } as any,
        },
        {
            selector: 'edge[edgeColour]',
            style: {
                'line-color': 'data(edgeColour)',
                'target-arrow-color': 'data(edgeColour)',
            } as any,
        },
        {
            selector: 'edge',
            style: {
                'width': 1,
                'target-arrow-shape': 'triangle',
                'curve-style': 'bezier',
                'font-size': 7,
                'font-family': FONT_FAMILY,
                'color': t.network.edgeLabelText,
                'edge-distances': 'node-position',
                'text-rotation': 'autorotate' as any,
                'text-margin-y': -8,
                'text-background-color': t.network.edgeLabelBg,
                'text-background-opacity': 0.7,
                'text-background-padding': '2px',
                'z-index': 109,
            } as any,
        },
        // -- gene-view regulatory edges: width scaled by binding site (opacity handled below) --
        {
            selector: 'edge[kind="activation"][at], edge[kind="repression"][at]',
            style: {
                'width': 'mapData(at, 0.1, 10, 5, 1)',
            } as any,
        },
        {
            selector: 'edge[kind="proteolysis"]',
            style: {
                'width': 1.5,
                'target-arrow-shape': 'diamond',
            } as any,
        },
        {
            selector: 'edge[kind="repression"]',
            style: {
                'target-arrow-shape': 'tee',
            } as any,
        },
        // -- species-view regulatory edges: width scaled by binding site (opacity handled below) --
        // z-index well below the (now explicit z=10) gene compounds so edges
        // visibly pass *behind* compounds they cross rather than over them.
        {
            selector: 'edge.species-view',
            style: {
                'font-size': 3,
                'arrow-scale': 0.8,
                'text-opacity': 1,
                'z-index': -100,
            } as any,
        },
        {
            selector: 'edge.species-view[at]',
            style: {
                'width': 'mapData(at, 0.1, 10, 2.5, 0.75)',
            } as any,
        },
        {
            selector: 'edge.species-view[kind="proteolysis"]',
            style: {
                'width': 1.0
            } as any,
        },
        // -- produces (summary edges for cross-gene reaction products) --
        {
            selector: 'edge[kind="produces"]',
            style: {
                'width': 1,
                'line-style': 'dashed',
                'target-arrow-shape': 'triangle',
                'arrow-scale': 0.6,
            } as any,
        },
        {
            selector: 'edge[kind="substrate"]',
            style: {
                'width': 0.5,
                'line-color': t.network.speciesEdgeColour,
                'target-arrow-color': t.network.speciesEdgeColour,
                'font-size': STOICH_LABEL_STYLE.fontSize,
                'arrow-scale': 0.15,
                'curve-style': 'unbundled-bezier',
                'control-point-step-size': 4,
                'text-margin-y': -1,
                'text-background-opacity': 0,
                'color': t.network.speciesEdgeLabelText,
            } as any,
        },
        {
            selector: 'edge[kind="product"]',
            style: {
                'width': 0.5,
                'line-color': t.network.speciesEdgeColour,
                'target-arrow-color': t.network.speciesEdgeColour,
                'font-size': STOICH_LABEL_STYLE.fontSize,
                'arrow-scale': 0.2,
                'curve-style': 'unbundled-bezier',
                'control-point-step-size': 4,
                'text-margin-y': -1,
                'text-background-opacity': 0,
                'color': t.network.speciesEdgeLabelText,
            } as any,
        },
        // -- reversible auxiliary reaction edges: a second (source) arrowhead
        //    makes the substrate/product edge read as bidirectional (⇌). The
        //    `reversible` flag is stamped on the reagent links by the backend.
        {
            selector: 'edge[kind="substrate"][?reversible]',
            style: {
                'source-arrow-shape': 'triangle',
                'source-arrow-color': t.network.speciesEdgeColour,
            } as any,
        },
        {
            selector: 'edge[kind="product"][?reversible]',
            style: {
                'source-arrow-shape': 'triangle',
                'source-arrow-color': t.network.speciesEdgeColour,
            } as any,
        },
        // -- peripheral Kronecker edges: barely visible, nearly inert in physics --
        {
            selector: 'edge.peripheral',
            style: {
                'label': ''
            } as any,
        },
        // -- differentiation tree edges: invisible but kept in fcose layout as springs --
        {
            selector: 'edge.differentiation_tree',
            style: {
                'opacity': 0,
                'events': 'no',
            } as any,
        },
        {
            selector: 'edge:loop',
            style: {
                'curve-style': 'unbundled-bezier',
                'control-point-step-size': 100,
                'loop-sweep': '60deg',
                'text-background-opacity': 0,
            } as any,
        },
        // ====================================================================
        // Opacity / z-index matrix.
        //
        // Cytoscape resolves conflicting properties by RULE ORDER — the last
        // matching rule wins — NOT by CSS specificity. It also does NOT
        // support `:not()` (such selectors are silently dropped, taking the
        // whole rule with them). So the override hierarchy is expressed
        // purely by ordering: each rule below overrides the earlier ones for
        // the elements it matches.
        //
        //   1. affinity gradient (base)        — activation/repression, species-view
        //   2. peripheral                      — overrides the gradient
        //   3. species-view self-reg (visible) — boost opacity, pull above compounds
        //   4. dimmed                          — selection dimming beats all the above
        //   5. species-view self-reg + dimmed  — also drop z behind the compound
        // ====================================================================
        {
            selector: 'edge[kind="activation"][at], edge[kind="repression"][at]',
            style: {
                'opacity': 'mapData(at, 0.1, 10, 1, 0.5)',
            } as any,
        },
        {
            // Species-view edges also match the activation/repression rule
            // above; coming later, this lower-opacity gradient wins for them.
            selector: 'edge.species-view[at]',
            style: {
                'opacity': 'mapData(at, 0.1, 10, 0.35, 0.15)',
            } as any,
        },
        {
            selector: 'edge.peripheral',
            style: {
                'opacity': PERIPHERAL_OPACITY * 0.5,
            } as any,
        },
        // -- self-regulatory edges in species view: pull above compounds and
        //    boost opacity so they aren't lost inside their own gene's box.
        {
            selector: 'edge.species-view.self-reg',
            style: {
                'z-index': 200,
                'opacity': 1,
            } as any,
        },
        // Selection dimming — comes after the gradient/peripheral/self-reg
        // rules so it wins for any dimmed edge.
        {
            selector: 'edge.dimmed',
            style: {
                'opacity': DIM_OPACITY,
            } as any,
        },
        // Dimmed self-reg: also drop z behind the compound. After the
        // `edge.dimmed` rule so it adds the z-index override without losing
        // the dim opacity.
        {
            selector: 'edge.species-view.self-reg.dimmed',
            style: {
                'z-index': -100,
                'opacity': DIM_OPACITY,
            } as any,
        },
        // ====================================================================
        // Editing overlays
        // ====================================================================
        // Hide the canvas label of a node currently being renamed (gene or
        // reaction) — the DOM overlay (InlineRename) replaces it faithfully.
        {
            selector: 'node.renaming',
            style: { 'text-opacity': 0 } as any,
        },
        // edgehandles draws two visuals during a draw: a "ghost" line from
        // source to cursor and a snapped "preview" edge. We hide the ghost
        // (busy + redundant once snap kicks in) and keep the preview, which
        // we style via stamped `kind` data (see EdgeCreation.edgeParams) so
        // it picks up the existing activation/repression/proteolysis rules.
        {
            selector: '.eh-ghost-edge',
            style: { 'opacity': 0, 'events': 'no' } as any,
        },
        // edgehandles applies a thick border to source/target by default;
        // we suppress it (the snap-styled preview edge is feedback enough).
        {
            selector: '.eh-source, .eh-target, .eh-hover',
            style: { 'border-width': 0, 'overlay-opacity': 0 } as any,
        },
    ]
}
