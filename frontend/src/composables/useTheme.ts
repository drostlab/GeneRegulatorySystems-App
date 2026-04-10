/**
 * Dark-mode composable.
 *
 * Provides a reactive `isDark` ref that:
 * - toggles `.app-dark` on <html> (PrimeVue + Monaco react automatically)
 * - persists preference in localStorage
 * - exposes callbacks so MainChart / NetworkView can re-theme imperatively
 */
import { ref, watch } from 'vue'
import logging from '@/utils/logging'

const log = logging.getLogger('useTheme')

const STORAGE_KEY = 'grs-dark-mode'

/** Read persisted preference, defaulting to light. */
function loadPreference(): boolean {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null) return stored === '1'
    // Respect OS preference when no explicit choice has been saved
    return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Module-level singleton so every caller shares the same ref. */
const isDark = ref(loadPreference())

/** Callbacks registered by imperative consumers (SciChart, Cytoscape). */
const listeners = new Set<(dark: boolean) => void>()

/** Apply the class to the DOM (idempotent). */
function applyClass(dark: boolean): void {
    document.documentElement.classList.toggle('app-dark', dark)
    log.debug(`Dark mode ${dark ? 'enabled' : 'disabled'}`)
}

// Apply immediately on module load
applyClass(isDark.value)

// Watch for changes
watch(isDark, (dark) => {
    applyClass(dark)
    localStorage.setItem(STORAGE_KEY, dark ? '1' : '0')
    listeners.forEach((fn) => fn(dark))
})

export function useTheme() {
    /** Toggle between light and dark. */
    function toggle(): void {
        isDark.value = !isDark.value
    }

    /**
     * Register a callback invoked on every theme change.
     * Returns an unsubscribe function.
     */
    function onThemeChange(fn: (dark: boolean) => void): () => void {
        listeners.add(fn)
        return () => listeners.delete(fn)
    }

    return { isDark, toggle, onThemeChange }
}
