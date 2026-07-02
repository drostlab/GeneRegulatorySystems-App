import { buildTrie, childrenAreParallel } from './executionTrie'

export function isPrefixPath(prefix: string, path: string): boolean {
    if (prefix === '' || prefix === path) return true
    if (!path.startsWith(prefix)) return false
    return ['/', '+', '-', '.'].includes(path[prefix.length] ?? '')
}

export function lineageChoicesForPaths(paths: string[], eachPrefixes: readonly string[]): Map<string, ReadonlyMap<string, string>> {
    const root = buildTrie(paths, eachPrefixes)
    const choices = new Map<string, ReadonlyMap<string, string>>()
    function visit(node: ReturnType<typeof buildTrie>, inherited: ReadonlyMap<string, string>): void {
        choices.set(node.path, inherited)
        const parallel = childrenAreParallel(node)
        for (const child of node.children) {
            const childChoices = new Map(inherited)
            if (parallel) childChoices.set(node.path, child.path)
            visit(child, childChoices)
        }
    }
    visit(root, new Map())
    return choices
}

export function pathsShareLineage(
    a: string,
    b: string,
    lineageChoices: ReadonlyMap<string, ReadonlyMap<string, string>>,
): boolean {
    const aChoices = lineageChoices.get(a) ?? new Map<string, string>()
    const bChoices = lineageChoices.get(b) ?? new Map<string, string>()
    for (const [fork, child] of aChoices) {
        const other = bChoices.get(fork)
        if (other !== undefined && other !== child) return false
    }
    return true
}
