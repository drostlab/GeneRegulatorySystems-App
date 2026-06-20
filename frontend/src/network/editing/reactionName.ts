/**
 * reactionName - canonical parsing of a reaction node's rate parameter symbol.
 *
 * Only *auxiliary* reactions (those in the model's `reactions` list) carry a
 * user-facing, renameable name. Their rate symbol is `reaction.<name>.k⁺`
 * (forward) or `reaction.<name>.k₋` (reverse). Note V1's asymmetry: forward
 * uses superscript plus (U+207A) but reverse uses *subscript* minus (U+208B).
 * The `<name>` may itself contain dots, but the trailing rate field never does,
 * so we match greedily up to the final `.k…` segment.
 *
 * Cascade reactions (`gene_1.processing`) and V1 transition reactions
 * (`gene.activation`) are generated per-gene, have no entry in `reactions`,
 * and are therefore *not* renameable — these helpers return null/false for
 * them. This is the single source of truth shared by the context menu,
 * validation, the rename overlay, and the canvas/tooltip labels.
 */

const AUX_RATE = /^reaction\.(.+)\.(k⁺|k₋|k_plus|k_minus|k\+|k-)$/

/**
 * The declared reaction name if `symbol` is an auxiliary reaction rate,
 * otherwise null.
 */
export function reactionNameFromRate(symbol: string | undefined | null): string | null {
    if (!symbol) return null
    const m = symbol.match(AUX_RATE)
    return m ? m[1] : null
}

/** Whether a rate field denotes the reverse direction of a reaction. */
export function isReverseRate(symbol: string): boolean {
    const m = symbol.match(AUX_RATE)
    if (!m) return false
    return m[2] === 'k₋' || m[2] === 'k_minus' || m[2] === 'k-'
}
