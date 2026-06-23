/**
 * Application Configuration
 *
 * Centralised configuration for API endpoints.
 * In browser mode, uses VITE_API_HOST (default localhost:8000).
 * In Tauri mode, the backend port is injected at runtime via IPC.
 */

let apiHost = import.meta.env.VITE_API_HOST || 'localhost:8000'
const apiProtocol = import.meta.env.VITE_API_PROTOCOL || 'http'

export const config = {
    /** API base URL for HTTP requests */
    get API_BASE() {
        return `${apiProtocol}://${apiHost}`
    },

    /** Whether the backend has been confirmed ready */
    backendReady: false,
}

/**
 * Set the backend host (called by Tauri integration on startup).
 */
export function setBackendHost(host: string): void {
    apiHost = host
    config.backendReady = true
}

/**
 * Detect whether running inside a Tauri webview.
 */
export function isTauri(): boolean {
    // Tauri v2 injects __TAURI_INTERNALS__; v1 used __TAURI__
    return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

export default config
