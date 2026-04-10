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
                await delay(retryDelay * Math.pow(2, attempt))
                continue
            }

            return response
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error))

            if (attempt === maxRetries) break

            console.warn(`[API] Retrying ${url} (attempt ${attempt + 1}/${maxRetries}) — ${lastError.message}`)
            await delay(retryDelay * Math.pow(2, attempt))
        }
    }

    throw lastError
}

/**
 * Helper to delay for retry backoff
 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Parse API error response
 */
export async function parseApiError(response: Response): Promise<string> {
    try {
        const data = (await response.json()) as { error?: string; message?: string }
        return data.error || data.message || `HTTP ${response.status}`
    } catch {
        return `HTTP ${response.status}: ${response.statusText}`
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
