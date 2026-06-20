/**
 * inlineEdit - shared input wiring for in-canvas text edits.
 *
 * Used by InlineParameters (parameter chips) and InlineRename (label overlay).
 * Handles the parts that are identical across call sites:
 *   - Enter commits, Escape cancels, blur commits (single-fire so Enter+blur
 *     doesn't fire commit twice)
 *   - Auto-width based on current value length
 *   - Focus + select after the input lands in the DOM
 *
 * Styling, positioning, and value parsing stay with the caller — they differ
 * enough between contexts that generalising them just pushes complexity into
 * options.
 */

export interface InlineEditOptions {
    initialValue: string
    /** Called with the raw input string on Enter or blur. */
    onCommit: (value: string) => void
    /** Called on Escape. Optional; default is a no-op. */
    onCancel?: () => void
    /** Minimum width in `ch` units. Defaults to 4. */
    minWidthCh?: number
}

export interface InlineEditHandle {
    input: HTMLInputElement
    /** Call after the input is attached to the DOM. */
    focusAndSelect: () => void
    /**
     * Detach listeners and mark the edit as finished so a subsequent DOM
     * removal (which fires `blur`) doesn't trigger `onCommit`. Use this for
     * external cancellation paths — e.g. tearing down the overlay because
     * the user opened another edit or because the component is destroying.
     */
    dispose: () => void
    /**
     * Re-arm the input for another commit attempt after a validation
     * failure. Callers that reject a commit (e.g. duplicate gene name) and
     * keep the input visible must call this, otherwise the internal
     * `finished` flag stays set and subsequent Enter/blur fire no-ops.
     */
    rearm: () => void
}

export function createInlineInput(opts: InlineEditOptions): InlineEditHandle {
    const minCh = opts.minWidthCh ?? 4

    const input = document.createElement('input')
    input.type = 'text'
    input.value = opts.initialValue
    input.style.width = `${Math.max(minCh, input.value.length + 1)}ch`

    let finished = false
    const finish = (fn: () => void) => {
        if (finished) return
        finished = true
        input.removeEventListener('blur', onBlur)
        fn()
    }

    const commit = () => opts.onCommit(input.value)
    const cancel = () => opts.onCancel?.()
    const onBlur = () => finish(commit)

    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); finish(commit) }
        else if (e.key === 'Escape') { e.preventDefault(); finish(cancel) }
    })
    input.addEventListener('input', () => {
        input.style.width = `${Math.max(minCh, input.value.length + 1)}ch`
    })
    input.addEventListener('blur', onBlur)

    return {
        input,
        focusAndSelect: () => {
            requestAnimationFrame(() => {
                input.focus()
                input.select()
            })
        },
        dispose: () => {
            finished = true
            input.removeEventListener('blur', onBlur)
        },
        rearm: () => {
            if (!finished) return
            finished = false
            input.addEventListener('blur', onBlur)
        },
    }
}
