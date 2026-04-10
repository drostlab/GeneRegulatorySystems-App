/**
 * Builds a PhaseSpaceResult client-side from the timeseries cache
 * for small gene selections (1-2 genes), avoiding a server round-trip.
 *
 * - 1 gene: X = mRNA counts, Y = protein counts
 * - 2 genes: X = gene1 protein, Y = gene2 protein
 */
import type { TimeseriesData, PhaseSpaceResult, PhaseSpacePoint } from '@/types/simulation'

/** Distinct saturated colours used when schedule colours are absent or all grey. */
const GENE_COLOUR_DEFAULTS = ['#e05252', '#5285e0', '#52c452', '#c4c452', '#c452c4', '#52c4c4']

/**
 * Build a 2D phase-space result from cached timeseries data.
 *
 * @param timeseries - Full timeseries cache (species -> path -> [[t, v], ...])
 * @param genes - 1 or 2 selected gene IDs
 * @param geneColours - Mapping from gene ID to hex colour
 * @param simulationId - Current simulation ID (for metadata)
 * @returns PhaseSpaceResult ready to pass to PhaseSpacePanel, or null if data is insufficient
 */
export function buildClientPhaseSpace(
    timeseries: TimeseriesData,
    genes: string[],
    geneColours: Record<string, string>,
    simulationId: string
): PhaseSpaceResult | null {
    if (genes.length === 1) {
        return buildSingleGenePhaseSpace(timeseries, genes[0]!, geneColours, simulationId)
    }
    if (genes.length === 2) {
        return buildTwoGenePhaseSpace(timeseries, genes[0]!, genes[1]!, geneColours, simulationId)
    }
    return null
}

/** 1 gene: X = mRNA, Y = protein. Each path becomes a trajectory. */
function buildSingleGenePhaseSpace(
    timeseries: TimeseriesData,
    gene: string,
    geneColours: Record<string, string>,
    simulationId: string
): PhaseSpaceResult | null {
    const mrnaKey = `${gene}.mrnas`
    const proteinKey = `${gene}.proteins`
    const mrnaByPath = timeseries[mrnaKey]
    const proteinByPath = timeseries[proteinKey]
    if (!mrnaByPath || !proteinByPath) return null

    const colour = geneColours[gene] ?? '#888888'
    const points = pairTimeseriesByPath(mrnaByPath, proteinByPath, colour, colour)
    if (points.length === 0) return null

    return {
        simulation_id: simulationId,
        method: 'client-2d',
        axis_labels: [`${gene} mRNA`, `${gene} protein`],
        axis_top_genes: [gene],
        points,
        n_genes: 1,
        n_cells: points.length,
    }
}

/** 2 genes: X = gene1 protein, Y = gene2 protein, softmax colouring. */
function buildTwoGenePhaseSpace(
    timeseries: TimeseriesData,
    gene1: string,
    gene2: string,
    geneColours: Record<string, string>,
    simulationId: string
): PhaseSpaceResult | null {
    const protein1ByPath = timeseries[`${gene1}.proteins`]
    const protein2ByPath = timeseries[`${gene2}.proteins`]
    if (!protein1ByPath || !protein2ByPath) return null

    const raw1 = geneColours[gene1]
    const raw2 = geneColours[gene2]
    // Only use schedule colours when both are saturated; otherwise fall back to
    // distinct defaults so the softmax blend is always visually meaningful.
    const bothSaturated = raw1 && raw2 && _isSaturated(raw1) && _isSaturated(raw2)
    const colour1 = bothSaturated ? raw1! : '#e05252'
    const colour2 = bothSaturated ? raw2! : '#5285e0'
    const points = pairTimeseriesByPath(protein1ByPath, protein2ByPath, colour1, colour2)
    if (points.length === 0) return null

    return {
        simulation_id: simulationId,
        method: 'client-2d',
        axis_labels: [`${gene1} protein`, `${gene2} protein`],
        axis_top_genes: [gene1, gene2],
        points,
        n_genes: 2,
        n_cells: points.length,
    }
}

/**
 * Pair two species' timeseries using step-forward interpolation.
 * At every event timestamp from either series, use the most recent known
 * value of each gene. This preserves all events rather than only the
 * exact-match inner join, which would drop nearly all SSA events.
 *
 * colour1/colour2 are hex colours for the two genes; each point is
 * softmax-blended between them based on the two values.
 */
function pairTimeseriesByPath(
    xByPath: Record<string, Array<[number, number]>>,
    yByPath: Record<string, Array<[number, number]>>,
    colour1: string,
    colour2: string,
): PhaseSpacePoint[] {
    const points: PhaseSpacePoint[] = []
    const rgb1 = _hexToRgb(colour1)
    const rgb2 = _hexToRgb(colour2)

    for (const path of Object.keys(xByPath)) {
        const xSeries = xByPath[path]
        const ySeries = yByPath[path]
        if (!xSeries || !ySeries || xSeries.length === 0 || ySeries.length === 0) continue

        // Merge all timestamps from both series, deduplicated and sorted
        const allTimes = Array.from(
            new Set([...xSeries.map(([t]) => t), ...ySeries.map(([t]) => t)])
        ).sort((a, b) => a - b)

        let xi = 0
        let yi = 0
        let xVal = xSeries[0]![1]
        let yVal = ySeries[0]![1]

        for (const t of allTimes) {
            // Advance step-forward pointer for x
            while (xi < xSeries.length && xSeries[xi]![0] <= t) {
                xVal = xSeries[xi]![1]
                xi++
            }
            // Advance step-forward pointer for y
            while (yi < ySeries.length && ySeries[yi]![0] <= t) {
                yVal = ySeries[yi]![1]
                yi++
            }
            const colour = _softmaxBlend(Math.log1p(xVal), Math.log1p(yVal), rgb1, rgb2)
            points.push({ x: xVal, y: yVal, path, t, colour })
        }
    }

    return points
}

type Rgb = [number, number, number]

function _hexToRgb(hex: string): Rgb {
    const h = hex.replace('#', '')
    if (h.length !== 6) return [0.5, 0.5, 0.5]
    const r = parseInt(h.slice(0, 2), 16) / 255
    const g = parseInt(h.slice(2, 4), 16) / 255
    const b = parseInt(h.slice(4, 6), 16) / 255
    if (isNaN(r) || isNaN(g) || isNaN(b)) return [0.5, 0.5, 0.5]
    return [r, g, b]
}

/** Mirror of the server-side _is_saturated: HSL saturation > 0.05. */
function _isSaturated(hex: string): boolean {
    const [r, g, b] = _hexToRgb(hex)
    const cmax = Math.max(r, g, b)
    const cmin = Math.min(r, g, b)
    const l = (cmax + cmin) / 2
    const denom = 1 - Math.abs(2 * l - 1)
    if (denom < 1e-6) return false
    return (cmax - cmin) / denom > 0.05
}

function _softmaxBlend(x: number, y: number, rgb1: Rgb, rgb2: Rgb): string {
    return _softmaxBlendN([x, y], [rgb1, rgb2])
}

function _softmaxBlendN(vals: number[], rgbs: Rgb[]): string {
    const max = Math.max(...vals)
    const exps = vals.map(v => Math.exp(v - max))
    const sum = exps.reduce((a, b) => a + b, 0)
    if (!isFinite(sum) || sum === 0) return '#888888'
    const weights = exps.map(e => e / sum)
    const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255)
    const r = clamp(weights.reduce((acc, w, i) => acc + w * rgbs[i]![0], 0))
    const g = clamp(weights.reduce((acc, w, i) => acc + w * rgbs[i]![1], 0))
    const b = clamp(weights.reduce((acc, w, i) => acc + w * rgbs[i]![2], 0))
    if (isNaN(r) || isNaN(g) || isNaN(b)) return '#888888'
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

/**
 * Recolour a PhaseSpaceResult using the selected genes' protein expression at each (path, t).
 * Each point's colour is a softmax blend over the selected genes, using saturated schedule
 * colours when all are saturated, otherwise distinct defaults.
 * Falls back to the original colours if no timeseries data is available.
 */
export function recolourPhaseSpace(
    result: PhaseSpaceResult,
    selectedGenes: string[],
    timeseries: TimeseriesData,
    geneColours: Record<string, string>,
): PhaseSpaceResult {
    if (selectedGenes.length === 0) return result

    // Build sorted lookup: gene -> path -> [(t, v), ...]
    const geneSeries = new Map<string, Map<string, Array<[number, number]>>>()
    for (const gene of selectedGenes) {
        const byPath = timeseries[`${gene}.proteins`]
        if (!byPath) continue
        const pathMap = new Map<string, Array<[number, number]>>()
        for (const [path, series] of Object.entries(byPath)) {
            pathMap.set(path, [...series].sort((a, b) => a[0] - b[0]))
        }
        geneSeries.set(gene, pathMap)
    }

    const availableGenes = [...geneSeries.keys()]
    if (availableGenes.length === 0) {
        // No timeseries data for any selected gene -- recolour by path as fallback
        const uniquePaths = [...new Set(result.points.map(p => p.path))]
        const pathColour = new Map(uniquePaths.map((path, i) => [
            path,
            GENE_COLOUR_DEFAULTS[i % GENE_COLOUR_DEFAULTS.length]!,
        ]))
        return { ...result, points: result.points.map(pt => ({ ...pt, colour: pathColour.get(pt.path) ?? '#888888' })) }
    }

    const rawColours = availableGenes.map(g => geneColours[g] ?? '')
    const allSaturated = rawColours.every(c => c && _isSaturated(c))
    const rgbs: Rgb[] = availableGenes.map((g, i) => {
        const c = allSaturated
            ? (geneColours[g] ?? GENE_COLOUR_DEFAULTS[i % GENE_COLOUR_DEFAULTS.length]!)
            : GENE_COLOUR_DEFAULTS[i % GENE_COLOUR_DEFAULTS.length]!
        return _hexToRgb(c)
    })

    function stepForward(series: Array<[number, number]>, t: number): number {
        let lo = 0, hi = series.length - 1, val = 0
        while (lo <= hi) {
            const mid = (lo + hi) >> 1
            if (series[mid]![0] <= t) { val = series[mid]![1]; lo = mid + 1 }
            else hi = mid - 1
        }
        return val
    }

    const newPoints = result.points.map(pt => {
        const vals = availableGenes.map(g => {
            const s = geneSeries.get(g)?.get(pt.path)
            return Math.log1p(s && s.length > 0 ? stepForward(s, pt.t) : 0)
        })
        return { ...pt, colour: _softmaxBlendN(vals, rgbs) }
    })

    return { ...result, points: newPoints }
}
