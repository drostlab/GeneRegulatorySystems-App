/**
 * Monaco Editor Composable – Encapsulates Monaco editor lifecycle
 *
 * Responsibilities:
 * - Initialize Monaco (bundled locally so it works offline)
 * - Create and manage editor instance
 * - Handle theme switching
 * - Content change callbacks
 *
 * Usage:
 * ```typescript
 * const { editor, initializeMonaco } = useMonacoEditor(container, onContentChange)
 * await initializeMonaco()
 * ```
 */

import { shallowRef } from 'vue'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import { RED, GREEN } from '@/config/theme'
import { hexToRgba, rgbaToHex } from '@/utils/colorUtils'

// Configure Monaco workers once for the whole app. Bundled by Vite so this
// works offline (no CDN fetch).
if (!(self as any).MonacoEnvironment) {
    (self as any).MonacoEnvironment = {
        getWorker(_: string, label: string) {
            if (label === 'json') return new jsonWorker()
            return new editorWorker()
        },
    }
}

export function useMonacoEditor(
    containerId: string,
    onContentChange?: (content: string) => void
) {
    const editor = shallowRef<any>(null)
    const scopeDecorationIds = shallowRef<string[]>([])
    let colorProviderRegistered = false

    /**
     * Register a colour provider for detecting hex colours in JSON (only once)
     */
    function registerColorProvider(monacoInstance: any) {
        if (colorProviderRegistered) return
        
        monacoInstance.languages.registerColorProvider('json', {
            provideDocumentColors: (model: any) => {
                const text = model.getValue()
                const colors: any[] = []
                
                // Match "color": "#RRGGBB" or "color": "#RRGGBBAA"
                const colorRegex = /"color"\s*:\s*"(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)"(?=\s*[,\}])/g
                let match
                
                while ((match = colorRegex.exec(text)) !== null) {
                    const hexColor = match[1]
                    // Position of the hex value within the full match
                    const offsetInMatch = match[0].indexOf(match[1])
                    const startOffset = match.index + offsetInMatch
                    const endOffset = startOffset + hexColor.length
                    
                    const startPos = model.getPositionAt(startOffset)
                    const endPos = model.getPositionAt(endOffset)
                    
                    const rgba = hexToRgba(hexColor)
                    
                    colors.push({
                        color: rgba,
                        range: {
                            startLineNumber: startPos.lineNumber,
                            startColumn: startPos.column,
                            endLineNumber: endPos.lineNumber,
                            endColumn: endPos.column
                        }
                    })
                }
                
                return colors
            },

            provideColorPresentations: (_model: any, colorInfo: any) => {
                const color = colorInfo.color
                const hex = rgbaToHex(color)
                return [{
                    label: hex
                }]
            }
        })
        
        colorProviderRegistered = true
    }

    /**
     * Define custom Atom One themes
     */
    function defineAtomThemes(monacoInstance: any) {
        monacoInstance.editor.defineTheme('atom-one-dark', {
            base: 'vs-dark',
            inherit: true,
            rules: [
                { token: 'string.key.json', foreground: RED[400].slice(1) },
                { token: 'string.value.json', foreground: GREEN[300].slice(1) },
                { token: 'number.json', foreground: 'd19a66' },
                { token: 'keyword.json', foreground: 'c678dd' },
                { token: 'comment.json', foreground: '5c6370' },
                { token: 'delimiter.json', foreground: 'abb2bf' },
                { token: 'delimiter.bracket.json', foreground: 'e06c75' }
            ],
            colors: {
                'editor.background': '#1d1f21'
            }
        })

        monacoInstance.editor.defineTheme('atom-one-light', {
            base: 'vs',
            inherit: true,
            rules: [
                { token: 'string.key.json', foreground: RED[500].slice(1) },
                { token: 'string.value.json', foreground: GREEN[600].slice(1) },
                { token: 'number.json', foreground: '986801' },
                { token: 'keyword.json', foreground: 'a626a4' },
                { token: 'comment.json', foreground: 'a0a1a7' },
                { token: 'delimiter.json', foreground: '383a42' },
                { token: 'delimiter.bracket.json', foreground: 'e45649' }
            ],
            colors: {
                'editor.background': '#fafafa',
                'editor.foreground': '#383a42',
                'editor.lineNumbersBackground': '#fafafa',
                'editor.lineNumbersForeground': '#9d9d9f',
                'editor.selectionBackground': '#e5e5e680',
                'editor.inactiveSelectionBackground': '#e5e5e640',
                'editor.lineHighlightBackground': '#f0f0f1',
                'editorCursor.foreground': '#4078f2',
                'editorWhitespace.foreground': '#d0d0d0'
            }
        })
    }

    /**
     * Create the editor instance
     */
    function createEditor(monacoInstance: any, initialContent: string, isEditing: boolean) {
        const container = document.getElementById(containerId)
        if (!container || editor.value) return

        const isDark = document.documentElement.classList.contains('app-dark')

        try {
            editor.value = monacoInstance.editor.create(container, {
                value: initialContent,
                language: 'json',
                theme: isDark ? 'atom-one-dark' : 'atom-one-light',
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 11,
                fontFamily: "'Fira Code', monospace",
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                readOnly: !isEditing,
                cursorStyle: isEditing ? 'line' : 'hidden',
                scrollbar: {
                    vertical: 'auto',
                    horizontal: 'auto',
                    useShadows: false,
                    verticalSliderSize: 6,
                    horizontalSliderSize: 6
                }
            })

            editor.value.onDidChangeModelContent(() => {
                // Only process changes if explicitly in edit mode
                // Don't call onContentChange during programmatic setValue() calls
                if (editor.value) {
                    const newContent = editor.value.getValue()
                    if (onContentChange)
                        onContentChange(newContent)
                }
            })

            // Setup theme switching on dark mode toggle
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.attributeName === 'class' && editor.value) {
                        const newIsDark = document.documentElement.classList.contains('app-dark')
                        const newTheme = newIsDark ? 'atom-one-dark' : 'atom-one-light'
                        monacoInstance.editor.setTheme(newTheme)
                    }
                })
            })

            observer.observe(document.documentElement, { attributes: true })

            // Store observer for cleanup
            ;(editor.value as any).__themeObserver = observer
        } catch (err) {
            console.error('[useMonacoEditor] Failed to create editor:', err)
            editor.value = null
        }
    }

    /**
     * Initialize Monaco (bundled locally — works offline)
     */
    function init(initialContent: string = '', isEditing: boolean = false): Promise<void> {
        defineAtomThemes(monaco)
        registerColorProvider(monaco)
        createEditor(monaco, initialContent, isEditing)
        return Promise.resolve()
    }

    /**
     * Update editor content
     */
    function setValue(content: string) {
        if (!editor.value) {
            console.warn('[useMonacoEditor] editor.value is null/undefined, cannot setValue')
            return
        }
        editor.value.setValue(content)
    }

    function getContent(): string {
        return editor.value?.getModel()?.getValue() ?? ' '
    }

    /**
     * Update editor options (e.g., readOnly)
     */
    function updateOptions(options: any) {
        if (editor.value) {
            editor.value.updateOptions(options)
        }
    }

    /**
     * Highlight a range (by character offsets) in the editor.
     * Pass `scroll = true` to reveal the range in the centre of the viewport.
     * Replaces any previously set scope highlight.
     */
    function highlightScope(startOffset: number, endOffset: number, scroll = false): void {
        if (!editor.value) return
        const model = editor.value.getModel()
        if (!model) return

        const startPos = model.getPositionAt(startOffset)
        const endPos = model.getPositionAt(endOffset)
        const cls = 'scope-highlight'
        const decorations: any[] = []

        if (startPos.lineNumber === endPos.lineNumber) {
            // Single line — exact range only
            decorations.push({
                range: {
                    startLineNumber: startPos.lineNumber, startColumn: startPos.column,
                    endLineNumber: endPos.lineNumber, endColumn: endPos.column,
                },
                options: { className: cls },
            })
        } else {
            // First line — exact start, extends to right edge via CSS ::after
            decorations.push({
                range: {
                    startLineNumber: startPos.lineNumber, startColumn: startPos.column,
                    endLineNumber: startPos.lineNumber, endColumn: model.getLineMaxColumn(startPos.lineNumber),
                },
                options: { className: `${cls}-first` },
            })
            // Middle lines — full width
            if (endPos.lineNumber - startPos.lineNumber > 1) {
                decorations.push({
                    range: {
                        startLineNumber: startPos.lineNumber + 1, startColumn: 1,
                        endLineNumber: endPos.lineNumber - 1, endColumn: 1,
                    },
                    options: { className: cls, isWholeLine: true },
                })
            }
            // Last line — start of line to exact end position
            decorations.push({
                range: {
                    startLineNumber: endPos.lineNumber, startColumn: 1,
                    endLineNumber: endPos.lineNumber, endColumn: endPos.column,
                },
                options: { className: cls },
            })
        }

        scopeDecorationIds.value = editor.value.deltaDecorations(scopeDecorationIds.value, decorations)

        if (scroll) {
            editor.value.revealRangeInCenter({
                startLineNumber: startPos.lineNumber, startColumn: startPos.column,
                endLineNumber: endPos.lineNumber, endColumn: endPos.column,
            })
        }
    }

    /** Remove the current scope highlight decoration. */
    function clearScopeHighlight(): void {
        if (!editor.value) return
        scopeDecorationIds.value = editor.value.deltaDecorations(scopeDecorationIds.value, [])
    }

    /**
     * Cleanup: disconnect observers and dispose editor
     */
    function dispose() {
        if (editor.value) {
            const observer = (editor.value as any).__themeObserver
            if (observer) {
                observer.disconnect()
            }
            editor.value.dispose()
            editor.value = null
        }
    }

    return {
        init,
        setValue,
        getContent,
        updateOptions,
        highlightScope,
        clearScopeHighlight,
        dispose
    }
}
