/**
 * Display mode types for chart panel viewing styles.
 *
 * Two composable axes:
 * - GeneLayout: how genes are arranged on the y-axis
 * - PathDisplay: how execution paths are rendered
 */

/** How genes are arranged on the y-axis in CountsPanels. */
export type GeneLayout = 'overlaid' | 'stacked'

/** How execution paths are rendered in CountsPanels and PromoterPanel. */
export type PathDisplay = 'overlaid' | 'stacked' | 'mean-se'

/** Summary timeseries for mean+SE display (one entry per species). */
export interface SpeciesSummary {
    time: number[]
    mean: number[]
    se: number[]
}

/** Response from the /timeseries/summary endpoint. */
export type TimeseriesSummary = Record<string, SpeciesSummary>
