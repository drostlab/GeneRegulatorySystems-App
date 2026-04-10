/**
 * Log Store
 *
 * Ring-buffer backed store for backend and frontend log lines.
 * Used by the diagnostic log drawer to show recent output.
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface LogLine {
    timestamp: number
    source: 'backend' | 'frontend'
    level: 'debug' | 'info' | 'warn' | 'error' | 'stdout' | 'stderr'
    text: string
}

const MAX_LINES = 2000

export const useLogStore = defineStore('log', () => {
    const lines = ref<LogLine[]>([])
    const drawerVisible = ref(false)

    function push(line: LogLine): void {
        lines.value.push(line)
        if (lines.value.length > MAX_LINES) {
            lines.value = lines.value.slice(-MAX_LINES)
        }
    }

    function pushBackend(text: string, stream: string): void {
        push({
            timestamp: Date.now(),
            source: 'backend',
            level: stream === 'stderr' ? 'stderr' : 'stdout',
            text,
        })
    }

    function pushFrontend(level: 'debug' | 'info' | 'warn' | 'error', text: string): void {
        push({
            timestamp: Date.now(),
            source: 'frontend',
            level,
            text,
        })
    }

    function toggleDrawer(): void {
        drawerVisible.value = !drawerVisible.value
    }

    function showDrawer(): void {
        drawerVisible.value = true
    }

    const backendLines = computed(() => lines.value.filter(l => l.source === 'backend'))
    const frontendLines = computed(() => lines.value.filter(l => l.source === 'frontend'))

    /** Format all logs as plain text for clipboard/export. */
    function formatAll(): string {
        return lines.value
            .map(l => {
                const ts = new Date(l.timestamp).toISOString()
                return `[${ts}] [${l.source}:${l.level}] ${l.text}`
            })
            .join('\n')
    }

    function clear(): void {
        lines.value = []
    }

    return {
        lines,
        backendLines,
        frontendLines,
        drawerVisible,
        push,
        pushBackend,
        pushFrontend,
        toggleDrawer,
        showDrawer,
        formatAll,
        clear,
    }
})
