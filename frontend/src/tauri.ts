/**
 * Tauri Integration
 *
 * Bridges the Tauri IPC layer with the app configuration.
 * In Tauri mode: fetches the Julia backend port from Rust, shows startup
 * progress on the static loading screen, handles the interactive Julia
 * runtime choice, streams backend log output, and configures the API URL.
 * In browser mode: marks backend as ready immediately (using VITE_API_HOST).
 */

import { config, isTauri, setBackendHost } from '@/config/api'
import { useLogStore } from '@/stores/logStore'
import { useViewerStore } from '@/stores/viewerStore'
import logging from '@/utils/logging'

const logger = logging.getLogger('tauri')

// ===========================================================================
// Loading screen helpers
// ===========================================================================

/** Update the static loading screen message (in index.html). */
function setStartupMessage(text: string): void {
    const el = document.getElementById('startup-message')
    if (el) el.textContent = text
}

/** Show an error state on the loading screen (stops the spinner). */
function setStartupError(text: string): void {
    const spinner = document.getElementById('startup-spinner')
    if (spinner) spinner.style.display = 'none'

    const msg = document.getElementById('startup-message')
    if (msg) {
        msg.textContent = text
        msg.style.color = '#ef4444'
    }
}

// ===========================================================================
// Terminal output
// ===========================================================================

let terminalVisible = false
let hasReceivedOutput = false

/** Append a line to the collapsible terminal area. */
function appendTerminalLine(text: string, stream: string): void {
    const terminal = document.getElementById('startup-terminal')
    const toggle = document.getElementById('startup-terminal-toggle')
    if (!terminal || !toggle) return

    // Auto-expand on first output line so the user sees progress
    if (!hasReceivedOutput) {
        hasReceivedOutput = true
        terminalVisible = true
        toggle.style.display = 'inline-block'
        toggle.textContent = 'Hide details'
        terminal.style.display = 'block'
    }

    const line = document.createElement('span')
    line.textContent = text + '\n'
    if (stream === 'stderr') {
        line.style.color = '#f59e0b'
    }
    terminal.appendChild(line)

    // Auto-scroll to bottom
    terminal.scrollTop = terminal.scrollHeight
}

/** Wire up the terminal toggle button. */
function initTerminalToggle(): void {
    const toggle = document.getElementById('startup-terminal-toggle')
    const terminal = document.getElementById('startup-terminal')
    if (!toggle || !terminal) return

    toggle.addEventListener('click', () => {
        terminalVisible = !terminalVisible
        terminal.style.display = terminalVisible ? 'block' : 'none'
        toggle.textContent = terminalVisible ? 'Hide details' : 'Show details'
    })
}

// ===========================================================================
// Julia choice prompt
// ===========================================================================

interface JuliaPrompt {
    situation: string        // "compatible", "outdated", "not_found"
    system_version: string
    system_path: string
    min_version: string
    download_version: string
    depot_path: string
    has_matching_manifest: boolean
}

/** Show the Julia choice UI and return the user's decision. */
async function handleJuliaPrompt(prompt: JuliaPrompt): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core')

    const container = document.getElementById('julia-choice')
    const textEl = document.getElementById('julia-choice-text')
    const buttonsEl = document.getElementById('julia-choice-buttons')
    const spinner = document.getElementById('startup-spinner')

    if (!container || !textEl || !buttonsEl) return

    // Pause the spinner while waiting for user input
    if (spinner) spinner.style.display = 'none'

    container.style.display = 'block'
    buttonsEl.innerHTML = ''

    const depotNote =
        `\n\nPackages will be installed into an app-specific depot ` +
        `(${prompt.depot_path}).`

    const manifestNote = prompt.has_matching_manifest
        ? ``
        : ` No matching manifest ships for this Julia version — the first launch ` +
          `will resolve dependencies from scratch (this can take 5-10 minutes).`

    if (prompt.situation === 'compatible') {
        textEl.textContent =
            `Julia ${prompt.system_version} detected at ${prompt.system_path}. ` +
            `You can use it or download a dedicated copy (v${prompt.download_version}).` +
            manifestNote + depotNote

        addChoiceButton(buttonsEl, `Use system Julia (v${prompt.system_version})`, 'system', true, invoke)
        addChoiceButton(buttonsEl, `Download v${prompt.download_version}`, 'dedicated', false, invoke)
    } else if (prompt.situation === 'outdated') {
        textEl.textContent =
            `Julia ${prompt.system_version} found at ${prompt.system_path}, but version ${prompt.min_version}+ is required. ` +
            `Please update Julia or let the app download v${prompt.download_version}.` + depotNote

        addChoiceButton(buttonsEl, `Download v${prompt.download_version}`, 'dedicated', true, invoke)
    } else if (prompt.situation === 'not_found') {
        textEl.textContent =
            `Julia was not found on this system. ` +
            `You can provide the path to an existing Julia binary, ` +
            `or download v${prompt.download_version} automatically.` + depotNote

        addPathInput(buttonsEl, invoke)
        addChoiceButton(buttonsEl, `Download v${prompt.download_version}`, 'dedicated', false, invoke)
    }
}

/** Create and append a choice button. */
function addChoiceButton(
    parent: HTMLElement,
    label: string,
    choice: string,
    primary: boolean,
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): void {
    const btn = document.createElement('button')
    btn.textContent = label
    if (primary) btn.className = 'primary'

    btn.addEventListener('click', () => {
        // Hide the choice UI, restore spinner
        const container = document.getElementById('julia-choice')
        const spinner = document.getElementById('startup-spinner')
        if (container) container.style.display = 'none'
        if (spinner) spinner.style.display = 'block'

        invoke('resolve_julia_choice', { choice })
    })

    parent.appendChild(btn)
}

/** Create a path input row with a "Use this path" button. */
function addPathInput(
    parent: HTMLElement,
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): void {
    const row = document.createElement('div')
    row.style.cssText = 'display: flex; gap: 0.5rem; width: 100%; margin-bottom: 0.5rem;'

    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = '/path/to/julia'
    input.style.cssText =
        'flex: 1; padding: 0.4rem 0.6rem; border-radius: 6px; border: 1px solid #3f3f46; ' +
        'background: #18181b; color: #e4e4e7; font-size: 0.8rem; font-family: inherit;'

    const btn = document.createElement('button')
    btn.textContent = 'Use this path'
    btn.className = 'primary'
    btn.addEventListener('click', () => {
        const path = input.value.trim()
        if (!path) return

        const container = document.getElementById('julia-choice')
        const spinner = document.getElementById('startup-spinner')
        if (container) container.style.display = 'none'
        if (spinner) spinner.style.display = 'block'

        invoke('resolve_julia_choice', { choice: `path:${path}` })
    })

    row.appendChild(input)
    row.appendChild(btn)
    parent.appendChild(row)
}

// ===========================================================================
// Initialisation
// ===========================================================================

/**
 * Initialise the backend connection.
 * Must be called before any API requests are made.
 *
 * Returns a promise that resolves when the backend is confirmed ready.
 */
export async function initialiseBackend(): Promise<void> {
    if (!isTauri()) {
        logger.info('Browser mode -- using default API host')
        config.backendReady = true
        return
    }

    logger.info('Tauri mode -- requesting backend port from Rust...')
    setStartupMessage('Connecting to backend...')
    initTerminalToggle()

    const { invoke } = await import('@tauri-apps/api/core')
    const { listen } = await import('@tauri-apps/api/event')
    const port: number = await invoke('get_backend_port')
    setBackendHost(`localhost:${port}`)
    logger.info(`Backend configured on port ${port}`)

    // Listen for structured progress events from Rust
    await listen<{ stage: string; message: string; done: boolean }>(
        'startup-progress',
        (event) => {
            const { stage, message } = event.payload
            logger.debug(`[startup] ${stage}: ${message}`)
            if (stage === 'error') {
                setStartupError(message)
            } else {
                setStartupMessage(message)
            }
        },
    )

    // Listen for Julia backend stdout/stderr lines
    await listen<{ stream: string; text: string }>(
        'backend-log',
        (event) => {
            appendTerminalLine(event.payload.text, event.payload.stream)
            useLogStore().pushBackend(event.payload.text, event.payload.stream)
        },
    )

    // Listen for the interactive Julia choice prompt
    await listen<JuliaPrompt>(
        'julia-prompt',
        (event) => {
            handleJuliaPrompt(event.payload)
        },
    )

    // Signal Rust that all listeners are registered
    await invoke('frontend_ready')
    logger.info('Signalled frontend_ready to Rust')

    // The backend may still be starting up (Julia is slow on first load).
    // Listen for the 'backend-ready' event from Rust.
    // Also poll as a fallback in case the event fired before we subscribed.
    const readyPromise = new Promise<void>((resolve) => {
        listen('backend-ready', () => {
            logger.info('Received backend-ready event')
            resolve()
        })

        // Fallback: poll the /schedules endpoint
        pollBackend(port, resolve)
    })

    await readyPromise
    config.backendReady = true
    logger.info('Backend is ready')
}

/** Poll the backend health until it responds. */
function pollBackend(port: number, onReady: () => void): void {
    const url = `http://localhost:${port}/schedules`
    const interval = setInterval(async () => {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
            if (response.ok) {
                clearInterval(interval)
                onReady()
            }
        } catch {
            // Backend not ready yet -- keep polling
        }
    }, 1000)
}

// ===========================================================================
// App menu (macOS menu bar / Windows menu)
// ===========================================================================

/** Set up the native app menu with a "View > Show Logs" item. */
export async function setupAppMenu(): Promise<void> {
    if (!isTauri()) return

    const { Menu } = await import('@tauri-apps/api/menu')
    const { Submenu } = await import('@tauri-apps/api/menu/submenu')
    const { MenuItem } = await import('@tauri-apps/api/menu/menuItem')
    const { CheckMenuItem } = await import('@tauri-apps/api/menu/checkMenuItem')
    const { PredefinedMenuItem } = await import('@tauri-apps/api/menu/predefinedMenuItem')
    const { invoke } = await import('@tauri-apps/api/core')
    const { emit, listen } = await import('@tauri-apps/api/event')
    const { openPath } = await import('@tauri-apps/plugin-opener')

    const dataDir: string = await invoke('get_data_dir')
    logger.info(`Data directory: ${dataDir}`)

    const revealFolder = async (subfolder: string): Promise<void> => {
        const path = `${dataDir}/${subfolder}`
        logger.info(`Opening folder: ${path}`)
        try {
            await openPath(path)
            logger.info(`Opened folder: ${path}`)
        } catch (e) {
            logger.error(`Failed to open folder ${path}: ${e}`)
        }
    }

    // macOS absorbs the first submenu into the app-named menu, which would
    // make "File" disappear. Reserve that slot with a minimal app submenu —
    // Quit alone is enough to make File show up as its own menu.
    const appSubmenu = await Submenu.new({
        text: 'GeneRegulatorySystems',
        items: [await PredefinedMenuItem.new({ item: 'Quit' })],
    })

    const exportSubmenu = await Submenu.new({
        text: 'Export',
        items: [
            await MenuItem.new({
                text: 'Schedule Spec (JSON)',
                action: () => { void emit('menu:export-schedule-json') },
            }),
            await MenuItem.new({
                text: 'Network Diagram (SVG)',
                action: () => { void emit('menu:export-network-svg') },
            }),
            await MenuItem.new({
                text: 'Simulation Chart (PNG)',
                action: () => { void emit('menu:export-simulation-png') },
            }),
        ],
    })

    const fileMenu = await Submenu.new({
        text: 'File',
        items: [
            await MenuItem.new({
                text: 'Open Schedules Folder',
                action: () => { revealFolder('schedules') },
            }),
            await MenuItem.new({
                text: 'Open Results Folder',
                action: () => { revealFolder('results') },
            }),
            await PredefinedMenuItem.new({ item: 'Separator' }),
            exportSubmenu,
        ],
    })

    const viewerStore = useViewerStore()

    const resizeByExpressionItem = await CheckMenuItem.new({
        id: 'toggle-resize-by-expression',
        text: 'Resize Genes by Expression',
        checked: viewerStore.resizeByExpressionEnabled,
        action: async () => {
            viewerStore.resizeByExpressionEnabled = !viewerStore.resizeByExpressionEnabled
            await resizeByExpressionItem.setChecked(viewerStore.resizeByExpressionEnabled)
        },
    })

    const editMenu = await Submenu.new({
        text: 'Edit',
        items: [
            await PredefinedMenuItem.new({ item: 'Undo' }),
            await PredefinedMenuItem.new({ item: 'Redo' }),
            await PredefinedMenuItem.new({ item: 'Separator' }),
            await PredefinedMenuItem.new({ item: 'Cut' }),
            await PredefinedMenuItem.new({ item: 'Copy' }),
            await PredefinedMenuItem.new({ item: 'Paste' }),
            await PredefinedMenuItem.new({ item: 'SelectAll' }),
        ],
    })

    const editorPanelItem = await CheckMenuItem.new({
        id: 'view-panel-editor',
        text: 'Editor',
        checked: true,
        action: () => { void emit('menu:toggle-panel:editor') },
    })
    const networkPanelItem = await CheckMenuItem.new({
        id: 'view-panel-network',
        text: 'Network',
        checked: true,
        action: () => { void emit('menu:toggle-panel:network') },
    })
    const schedulePanelItem = await CheckMenuItem.new({
        id: 'view-panel-schedule',
        text: 'Schedule',
        checked: true,
        action: () => { void emit('menu:toggle-panel:schedule') },
    })
    const simulationPanelItem = await CheckMenuItem.new({
        id: 'view-panel-simulation',
        text: 'Simulation',
        checked: true,
        action: () => { void emit('menu:toggle-panel:tracks') },
    })

    await listen<string[]>('workspace:panels-open', async event => {
        const open = new Set(event.payload)
        await editorPanelItem.setChecked(open.has('editor'))
        await networkPanelItem.setChecked(open.has('network'))
        await schedulePanelItem.setChecked(open.has('schedule'))
        await simulationPanelItem.setChecked(open.has('tracks'))
    })

    const viewMenu = await Submenu.new({
        text: 'View',
        items: [
            editorPanelItem,
            networkPanelItem,
            schedulePanelItem,
            simulationPanelItem,
            await PredefinedMenuItem.new({ item: 'Separator' }),
            resizeByExpressionItem,
        ],
    })

    const advancedMenu = await Submenu.new({
        text: 'Advanced',
        items: [
            await MenuItem.new({
                text: 'Show Diagnostic Logs',
                accelerator: 'CmdOrCtrl+Shift+L',
                action: () => useLogStore().showDrawer(),
            }),
            await PredefinedMenuItem.new({ item: 'Separator' }),
            await MenuItem.new({
                text: 'Reset Julia Environment…',
                action: () => { void invoke('reset_julia_environment_interactive') },
            }),
        ],
    })

    const menu = await Menu.new({
        items: [
            appSubmenu,
            fileMenu,
            editMenu,
            viewMenu,
            advancedMenu,
        ],
    })

    await menu.setAsAppMenu()
    logger.debug('App menu installed')
}
