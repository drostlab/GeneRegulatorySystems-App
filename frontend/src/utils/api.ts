/**
 * API utilities — centralised error handling and retry logic.
 *
 * No request timeout is enforced: the Julia backend can take minutes for
 * compilation or large simulations, so aborting early is harmful.
 * Retries (with exponential backoff) only fire on 5xx or network errors.
 */

import { config } from '@/config/api'

export interface FetchOptions extends RequestInit {
    maxRetries?: number
    retryDelay?: number
}

/**
 * Centralised fetch wrapper with retry logic for transient server errors.
 */
export async function apiFetch(endpoint: string, options: FetchOptions = {}): Promise<Response> {
    const url = `${config.API_BASE}${endpoint}`
    const { maxRetries = 3, retryDelay = 1000, ...fetchOptions } = options

    let lastError: Error = new Error('Unknown error')

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, fetchOptions)

            if (!response.ok && response.status >= 500 && attempt < maxRetries) {
                console.warn(`[API] Retrying ${url} (attempt ${attempt + 1}/${maxRetries}) — status ${response.status}`)
                await delay(retryDelay * Math.pow(2, attempt), fetchOptions.signal)
                continue
            }

            return response
        } catch (error) {
            if (fetchOptions.signal?.aborted || isAbortError(error)) throw error
            lastError = error instanceof Error ? error : new Error(String(error))

            if (attempt === maxRetries) break

            console.warn(`[API] Retrying ${url} (attempt ${attempt + 1}/${maxRetries}) — ${lastError.message}`)
            await delay(retryDelay * Math.pow(2, attempt), fetchOptions.signal)
        }
    }

    throw lastError
}

/**
 * Helper to delay for retry backoff
 */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

/**
 * Parse API error response
 */
export async function parseApiError(response: Response): Promise<string> {
    const text = await response.text().catch(() => '')
    try {
        const data = JSON.parse(text) as { error?: string; message?: string }
        return data.error || data.message || text || `HTTP ${response.status}: ${response.statusText}`
    } catch {
        return text || `HTTP ${response.status}: ${response.statusText}`
    }
}

/**
 * Fetch JSON with error handling
 * @param endpoint - The API endpoint
 * @param options - Fetch options
 * @returns Parsed JSON response
 */
export async function apiFetchJson<T = any>(
    endpoint: string,
    options: FetchOptions = {}
): Promise<T> {
    const response = await apiFetch(endpoint, options)
    
    if (!response.ok) {
        const error = await parseApiError(response)
        throw new Error(`API Error: ${error}`)
    }
    
    const data = (await response.json()) as T
    return data
}

/**
 * Fetch text with error handling
 * @param endpoint - The API endpoint
 * @param options - Fetch options
 * @returns Response as text
 */
export async function apiFetchText(endpoint: string, options: FetchOptions = {}): Promise<string> {
    const response = await apiFetch(endpoint, options)
    if (!response.ok) {
        const error = await parseApiError(response)
        throw new Error(`API Error: ${error}`)
    }
    return response.text()
}
