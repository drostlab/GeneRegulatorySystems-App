/**
 * jsonPathUtils
 *
 * Resolves a JSONPath segment array (as produced by the backend's
 * model_path_to_json_path) to a character-offset range inside a JSON text
 * string, using jsonc-parser's fault-tolerant AST.
 */

import { parseTree, findNodeAtLocation } from 'jsonc-parser'

/**
 * Find the text range for a JSONPath inside a JSON string.
 *
 * @param text - Raw JSON/JSONC source text
 * @param path - Segment array, e.g. `["step", 0, "do"]` (root = `[]`)
 * @returns `{ startOffset, endOffset }` or `null` if the path cannot be resolved
 */
export function findRangeForJsonPath(
    text: string,
    path: (string | number)[]
): { startOffset: number; endOffset: number } | null {
    const root = parseTree(text)
    if (!root) return null

    if (path.length === 0) {
        return { startOffset: root.offset, endOffset: root.offset + root.length }
    }

    const node = findNodeAtLocation(root, path)
    if (!node) return null

    return { startOffset: node.offset, endOffset: node.offset + node.length }
}
