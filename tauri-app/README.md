# Tauri Desktop App

Tauri v2 wrapper that bundles the Vue frontend and Julia backend into a native desktop application. On launch, the Rust side provisions a Julia runtime (system or downloaded), starts the backend server on a free port, and points the webview at the frontend.

## Prerequisites

- **Rust** >= 1.77.2 (`rustup` recommended: <https://rustup.rs>)
- **Node.js** >= 20.19 (for the frontend build)
- **Julia** >= 1.10 (for development; production builds can auto-download Julia 1.12)
- **Tauri CLI**: installed automatically by `dev.sh`, or manually via `cargo install tauri-cli`
- Platform-specific Tauri dependencies: see <https://v2.tauri.app/start/prerequisites/>

## Development

The easiest way is via the root helper script:

```sh
./dev.sh --tauri
```

This starts Vite in dev mode on port 1420 and launches the Tauri window with hot-reload.

Alternatively, from the `tauri-app/` directory:

```sh
cargo tauri dev
```

> `beforeDevCommand` in `tauri.conf.json` automatically runs `npm run dev` in `../frontend`.

## Production Build

```sh
cargo tauri build
```

This:

1. Runs `npm run build` in `../frontend` (via `beforeBuildCommand`).
2. Compiles the Rust binary in release mode.
3. Bundles platform-specific installers (`.dmg`/`.app` on macOS, `.msi`/`.exe` on Windows, `.deb`/`.AppImage` on Linux).

Output is written to `target/release/bundle/`.

### Bundled Resources

The build bundles the Julia backend source into the app (configured in `tauri.conf.json` under `bundle.resources`):

| Source | Bundle path |
|---|---|
| `backend/run.jl` | `server/run.jl` |
| `backend/Project.toml` | `server/Project.toml` |
| `backend/Manifest.toml` | `server/Manifest.toml` |
| `backend/src/*` | `server/src/` |
| `backend/examples/*` | `server/examples/` |
| `grs-package/` | `server/grs-package/` |

## Julia Runtime Provisioning

Handled by `src/julia.rs`. Three modes:

1. **Dev mode** -- uses system `julia` on PATH with the global depot.
2. **Production, system Julia found** -- checks version compatibility (>= 1.10).
3. **Production, no system Julia** -- downloads pinned Julia 1.12.0 from the official CDN, verified by SHA256 checksum.

Production builds use an isolated Julia depot inside the app data directory.

## Project Structure

```
tauri-app/
  src/
    main.rs       -- entry point
    lib.rs        -- Tauri setup, backend lifecycle, startup progress events
    julia.rs      -- Julia detection, download, verification
  capabilities/
    default.json  -- Tauri permission capabilities
  tauri.conf.json -- build config, window settings, bundled resources
  Cargo.toml      -- Rust dependencies
```
