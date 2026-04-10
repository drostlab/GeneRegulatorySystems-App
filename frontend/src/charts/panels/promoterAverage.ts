/**
 * Averages digital promoter timeseries across execution paths.
 *
 * Each path has a step-function series of [time, state] where state is 0 or 1
 * (with -1 as gap marker). This merges all time points from all paths and
 * computes the mean state at each point, producing a fractional activity (0-1).
 */

type StepSeries = Array<[number, number]>

interface AveragedGeneData {
    colour: string
    /** Averaged step-function series: [time, meanActivity] where meanActivity is 0..1 */
    series: Array<[number, number]>
}

/**
 * For each gene, average promoter activity across all paths.
 *
 * @param dataByPath  Output of restructureTimeseriesByPathAndGene
 * @returns One averaged series per gene
 */
export function averagePromoterByGene(
    dataByPath: Record<string, Record<string, { colour: string; series: StepSeries }>>
): Record<string, AveragedGeneData> {
    // Collect all path series per gene
    const genePathSeries = new Map<string, { colour: string; series: StepSeries[] }>()

    for (const geneData of Object.values(dataByPath)) {
        for (const [geneId, { colour, series }] of Object.entries(geneData)) {
            if (!genePathSeries.has(geneId)) {
                genePathSeries.set(geneId, { colour, series: [] })
            }
            genePathSeries.get(geneId)!.series.push(series)
        }
    }

    const result: Record<string, AveragedGeneData> = {}
    for (const [geneId, { colour, series: allSeries }] of genePathSeries) {
        result[geneId] = {
            colour,
            series: _averageStepFunctions(allSeries)
        }
    }
    return result
}

/**
 * Average multiple step-function series into a single series.
 *
 * Merges all unique time points, evaluates each step function at those points,
 * and computes the mean. Gap markers (-1) are excluded from averaging.
 */
function _averageStepFunctions(allSeries: StepSeries[]): Array<[number, number]> {
    if (allSeries.length === 0) return []
    if (allSeries.length === 1) return allSeries[0]!

    // Collect all unique time points (excluding gap markers)
    const timeSet = new Set<number>()
    for (const series of allSeries) {
        for (const [t, state] of series) {
            if (state !== -1) {
                timeSet.add(t)
            }
        }
    }

    const times = [...timeSet].sort((a, b) => a - b)
    if (times.length === 0) return []

    const result: Array<[number, number]> = []

    for (const t of times) {
        let sum = 0
        let count = 0
        for (const series of allSeries) {
            const val = _evaluateStepAt(series, t)
            if (val !== null) {
                sum += val
                count++
            }
        }
        if (count > 0) {
            result.push([t, sum / count])
        }
    }

    return result
}

/**
 * Evaluate a step function at time t using last-value-before-or-at semantics.
 * Returns null if t is before the first point or inside a gap.
 */
function _evaluateStepAt(series: StepSeries, t: number): number | null {
    let lastState: number | null = null
    for (const [time, state] of series) {
        if (time > t) break
        if (state === -1) {
            lastState = null
        } else {
            lastState = state
        }
    }
    return lastState
}
