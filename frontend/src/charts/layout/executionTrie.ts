/**
 * Path-first trie over the engine's native `execution_path` grammar.
 *
 * GRS.jl serialises the unrolled execution topology directly into each path; the
 * separator that introduces a token says how that node relates to its parent:
 *
 * - `+name` — descend a non-branch `Scope` (single child, in series)
 * - `-i`    — sequence item `i` (siblings run in series)
 * - `/i`    — branch item `i` (siblings run in parallel — `/` marks branch points)
 * - `.name` — descend into a binding/definition (in series)
 *
 * So branch-vs-sequence is read straight off the `/` vs `-` separator — no
 * time-overlap heuristic. A `:to` loop re-running the same sub-schedule emits the
 * *same* path repeatedly, so it collapses to a single node. See
 * docs/schedule-view-redesign.md.
 *
 * Phase C ships only this parser; the y-range layout that consumes it lives in the
 * phase-D schedule component.
 */

const SEPARATORS = new Set(['+', '-', '/', '.'])

export interface TrieNode {
    /** Full execution-path prefix identifying this node (`''` for the root). */
    path: string
    /** Separator that introduced this node from its parent (`''` for the root). */
    sep: string
    children: TrieNode[]
}

/** A token boundary: the cumulative path prefix and the separator that opened it. */
interface Token {
    prefix: string
    sep: string
}

/**
 * Split an execution path into its token boundaries. Each token is a separator
 * char followed by a (possibly empty) label, e.g. `+-2/2+-1` →
 * `+`, `+-2`, `+-2/2`, `+-2/2+`, `+-2/2+-1`.
 */
function tokenize(path: string): Token[] {
    const tokens: Token[] = []
    let i = 0
    while (i < path.length) {
        const sep = path[i]!
        let j = i + 1
        while (j < path.length && !SEPARATORS.has(path[j]!)) j++
        tokens.push({ prefix: path.slice(0, j), sep })
        i = j
    }
    return tokens
}

/**
 * Build a path-first trie from a set of execution paths. Repeated paths (e.g. a
 * `:to` loop) collapse onto the same nodes. Children are kept in first-seen order.
 */
export function buildTrie(paths: Iterable<string>): TrieNode {
    const root: TrieNode = { path: '', sep: '', children: [] }
    const byPath = new Map<string, TrieNode>([['', root]])

    for (const path of paths) {
        let parent = root
        for (const { prefix, sep } of tokenize(path)) {
            let node = byPath.get(prefix)
            if (!node) {
                node = { path: prefix, sep, children: [] }
                byPath.set(prefix, node)
                parent.children.push(node)
            }
            parent = node
        }
    }
    return root
}

/**
 * A node's children run in parallel (branch) iff they were introduced by the `/`
 * separator. A branching `Scope` introduces every item with `/`, so the first
 * child's separator is sufficient.
 */
export function childrenAreParallel(node: TrieNode): boolean {
    return node.children.length > 0 && node.children[0]!.sep === '/'
}
