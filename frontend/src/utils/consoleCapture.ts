/**
 * Frontend console capture.
 *
 * Intercepts console.info/warn/error and pushes lines to the log store.
 * Debug is only captured in dev mode (matching the logging utility).
 * Must be called once after Pinia is installed.
 */

import { useLogStore } from '@/stores/logStore'

const IS_DEV = import.meta.env.DEV

export function installConsoleCapture(): void {
    const store = useLogStore()

    const originalInfo = console.info.bind(console)
    const originalWarn = console.warn.bind(console)
    const originalError = console.error.bind(console)
    const originalDebug = console.debug.bind(console)

    console.info = (...args: unknown[]) => {
        originalInfo(...args)
        store.pushFrontend('info', args.map(String).join(' '))
    }

    console.warn = (...args: unknown[]) => {
        originalWarn(...args)
        store.pushFrontend('warn', args.map(String).join(' '))
    }

    console.error = (...args: unknown[]) => {
        originalError(...args)
        store.pushFrontend('error', args.map(String).join(' '))
    }

    if (IS_DEV) {
        console.debug = (...args: unknown[]) => {
            originalDebug(...args)
            store.pushFrontend('debug', args.map(String).join(' '))
        }
    }
}
