/**
 * Lightweight tagged logger.
 *
 * Each logger prefixes messages with `[tag]` and delegates to `console`.
 * Debug output is only emitted when the build is in development mode.
 */

interface Logger {
    debug: (...args: unknown[]) => void
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
}

const IS_DEV = import.meta.env.DEV

function getLogger(tag: string): Logger {
    const prefix = `[${tag}]`
    return {
        debug: (...args: unknown[]) => { if (IS_DEV) console.debug(prefix, ...args) },
        info: (...args: unknown[]) => console.info(prefix, ...args),
        warn: (...args: unknown[]) => console.warn(prefix, ...args),
        error: (...args: unknown[]) => console.error(prefix, ...args),
    }
}

export default { getLogger }
