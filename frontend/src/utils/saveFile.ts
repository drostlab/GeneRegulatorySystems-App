/**
 * File saving utility.
 *
 * In Tauri mode: shows a native "Save As" dialog and writes directly to disk.
 * In browser mode: triggers a standard browser download.
 */

import { isTauri } from '@/config/api'
import logging from '@/utils/logging'

const logger = logging.getLogger('saveFile')

interface SaveFileOptions {
    /** Default filename (used for both browser download and dialog suggestion). */
    filename: string
    /** MIME type of the content. */
    mimeType: string
    /** Human-readable filter label, e.g. "SVG Image". */
    filterName: string
    /** File extensions for the save dialog filter, e.g. ["svg"]. */
    extensions: string[]
}

/** Save a Blob to a file, using a native dialog in Tauri or a browser download otherwise. */
export async function saveFile(blob: Blob, options: SaveFileOptions): Promise<void> {
    if (isTauri()) {
        await saveViaTauri(blob, options)
    } else {
        saveViaBrowser(blob, options.filename)
    }
}

async function saveViaTauri(blob: Blob, options: SaveFileOptions): Promise<void> {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const { writeFile } = await import('@tauri-apps/plugin-fs')

    const path = await save({
        defaultPath: options.filename,
        filters: [{ name: options.filterName, extensions: options.extensions }],
    })

    if (!path) {
        logger.debug('Save cancelled by user')
        return
    }

    const buffer = new Uint8Array(await blob.arrayBuffer())
    await writeFile(path, buffer)
    logger.debug(`Saved file to ${path}`)
}

function saveViaBrowser(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
}
