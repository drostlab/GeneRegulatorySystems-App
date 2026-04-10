/**
 * Centralised colour and style tokens for the entire frontend.
 *
 * Architecture
 * ============
 * 1. PALETTES: raw hex scales — the only place hex values are defined.
 * 2. MODE THEMES: light / dark objects that reference palette entries.
 *    Both typed as ThemeMode so they are guaranteed to have the same shape.
 * 3. Edge colours: mode-independent (always visible on both backgrounds).
 * 4. getTheme(isDark): returns the resolved ThemeMode for the active mode.
 *
 * Consumers
 * ---------
 * - PrimeVue preset (main.ts): reads `palette.*` for primary / info / success.
 * - SciChart panels / modifiers: call getTheme() for hex strings.
 * - Cytoscape network: calls getTheme() for hex strings.
 * - CSS / Vue components: use PrimeVue CSS vars (--p-*) where possible,
 *   or import getTheme() when a resolved value is needed.
 */

import { type IThemeProvider, SciChartJSDarkv2Theme, SciChartJSLightTheme } from 'scichart'
import logging from '@/utils/logging'
import { desaturate, rotateHue, lighten } from '@/utils/colorUtils'

const log = logging.getLogger('theme')

// ═══════════════════════════════════════════════════════════════════════════
// 1. PALETTES  (single source of hex truth)
// ═══════════════════════════════════════════════════════════════════════════

/** Red scale — exact Aura/Tailwind values so token refs like {red.500} resolve identically. */
export const RED = {
    50:  '#fef2f2',
    100: '#fee2e2',
    200: '#fecaca',
    300: '#fca5a5',
    400: '#f87171',
    500: '#ef4444',
    600: '#dc2626',
    700: '#b91c1c',
    800: '#991b1b',
    900: '#7f1d1d',
    950: '#450a0a',
} as const

/** Green scale — exact Aura/Tailwind values so token refs like {green.500} resolve identically. */
export const _GREEN_BASE = {
    50:  '#f0fdf4',
    100: '#dcfce7',
    200: '#bbf7d0',
    300: '#86efac',
    400: '#4ade80',
    500: '#22c55e',
    600: '#16a34a',
    700: '#15803d',
    800: '#166534',
    900: '#14532d',
    950: '#052e16',
} as const

export const GREEN = Object.fromEntries(
    Object.entries(_GREEN_BASE).map(([k, v]) => [k, lighten(rotateHue(v, 10), 0.2)])
) as Record<keyof typeof _GREEN_BASE, string>

/** Neutral grey scale — exact Aura/Tailwind zinc values. */
export const GREY = {
    0:   '#ffffff',
    50:  '#fafafa',
    100: '#f4f4f5',
    200: '#e4e4e7',
    300: '#d4d4d8',
    350: '#c4c4cb',
    400: '#a1a1aa',
    500: '#71717a',
    600: '#52525b',
    700: '#3f3f46',
    800: '#27272a',
    900: '#18181b',
    950: '#09090b',
} as const

/** Exported palette aggregation for PrimeVue definePreset. */
export const palette = {
    red:   RED,
    green: GREEN,
    grey:  GREY,
} as const

// ═══════════════════════════════════════════════════════════════════════════
// 2. EDGE COLOURS  (mode-independent)
// ═══════════════════════════════════════════════════════════════════════════

export const EDGE_COLOURS: Record<string, string> = {
    activation:  desaturate(GREEN[400], 0.2),
    repression:  desaturate(RED[400],   0.2),
    proteolysis: '#FF7F00',
    produces:    '#7e868e',
    next:        '#4DAF4A',
    alternative: '#984EA3',
}

/** Fallback colour for unknown edge kinds. */
export const EDGE_COLOUR_FALLBACK = GREY[300]

/** Opacity for dimmed (unselected) network elements. */
export const DIM_OPACITY = 0.3

// ═══════════════════════════════════════════════════════════════════════════
// 3. MODE THEMES  (light + dark, identical shape)
// ═══════════════════════════════════════════════════════════════════════════

export interface ThemeMode {
    /** Surface / background colours. */
    surface: {
        bg: string
        card: string
        border: string
    }
    /** Text colours. */
    text: {
        base: string
        muted: string
        dim: string
    }
    /** SciChart shared colours. */
    chart: {
        gridLine: string
        cursor: string
        cursorText: string
        tooltipBg: string
        tooltipFg: string
        fallbackSeries: string
    }
    /** Timeline panel. */
    timeline: {
        instant: {
            normal: { line: string; bg: string; text: string }
            hover:  { line: string; bg: string; text: string }
        }
        rect: {
            colour:   string
            normal:   { stroke: string; text: string }
            hover:    { stroke: string; text: string }
            selected: { fill: string; stroke: string; text: string }
        }
        segmentBoundary: string
    }
    /** Network diagram. */
    network: {
        reactionBg: string
        highlightBorder: string
        edgeLabelText: string
        /** Label text colour for species/reaction-level edges (substrate, product). */
        speciesEdgeLabelText: string
        /** Line colour for species/reaction-level edges (substrate, product). */
        speciesEdgeColour: string
        edgeLabelBg: string
        dotGrid: string
        nodeFallback: string
        /** Gene node label colour. */
        geneLabelText: string
    }
    /** SciChart IThemeProvider instance. */
    sciChartTheme: IThemeProvider
}

const light: ThemeMode = {
    surface: {
        bg:     GREY[50],
        card:   GREY[0],
        border: GREY[200],
    },
    text: {
        base:  GREY[950],
        muted: GREY[600],
        dim:   GREY[400],
    },
    chart: {
        gridLine:       GREY[100],
        cursor:         GREY[700],
        cursorText:     GREY[0],
        tooltipBg:      GREY[700],
        tooltipFg:      GREY[0],
        fallbackSeries: GREY[400],
    },
    timeline: {
        instant: {
            normal: { line: GREY[50],  bg: GREY[50],  text: GREY[600]  },
            hover:  { line: RED[300],  bg: RED[300],  text: GREY[950]  },
        },
        rect: {
            colour:   GREY[200],
            normal:   { stroke: GREY[300], text: GREY[500] },
            hover:    { stroke: GREY[400], text: GREY[700] },
            selected: { fill: RED[200], stroke: GREY[300], text: GREY[900] },
        },
        segmentBoundary: GREY[400],
    },
    network: {
        reactionBg:           GREY[300],
        highlightBorder:      GREY[950],
        edgeLabelText:        GREY[900],
        speciesEdgeLabelText: GREY[700],
        speciesEdgeColour:    GREY[350],
        edgeLabelBg:          GREY[0],
        dotGrid:              GREY[300],
        nodeFallback:         GREY[400],
        geneLabelText:        GREY[950],
    },
    sciChartTheme: new SciChartJSLightTheme(),
}

const dark: ThemeMode = {
    surface: {
        bg:     GREY[950],
        card:   GREY[900],
        border: GREY[700],
    },
    text: {
        base:  GREY[50],
        muted: GREY[400],
        dim:   GREY[600],
    },
    chart: {
        gridLine:       GREY[700],
        cursor:         GREY[800],
        cursorText:     GREY[0],
        tooltipBg:      GREY[200],
        tooltipFg:      GREY[950],
        fallbackSeries: GREY[500],
    },
    timeline: {
        instant: {
            normal: { line: GREY[500], bg: GREY[800], text: GREY[300] },
            hover:  { line: RED[400],  bg: RED[400],  text: GREY[50]  },
        },
        rect: {
            colour:   GREY[700],
            normal:   { stroke: GREY[600], text: GREY[400] },
            hover:    { stroke: GREY[400], text: GREY[200] },
            selected: { fill: RED[950], stroke: RED[900], text: GREY[50] },
        },
        segmentBoundary: GREY[700],
    },
    network: {
        reactionBg:           GREY[500],
        highlightBorder:      GREY[950],
        edgeLabelText:        GREY[100],
        speciesEdgeLabelText: GREY[200],
        speciesEdgeColour:    GREY[500],
        edgeLabelBg:          GREY[800],
        dotGrid:              GREY[800],
        nodeFallback:         GREY[500],
        geneLabelText:        GREY[100],
    },
    sciChartTheme: new SciChartJSDarkv2Theme(),
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. THEME ACCESS
// ═══════════════════════════════════════════════════════════════════════════

/** Returns the fully resolved theme for the given mode. */
export function getTheme(isDark: boolean): ThemeMode {
    const t = isDark ? dark : light
    log.debug(`Resolved theme: ${isDark ? 'dark' : 'light'}`)
    return t
}
