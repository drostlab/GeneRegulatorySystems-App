#!/bin/bash
set -euo pipefail

# Development launcher for the GRS app.
#
# Usage:
#   ./dev.sh                    Start Vite frontend + Julia backend (browser mode)
#   ./dev.sh --tauri            Start via Tauri (desktop window, Julia spawned by Rust)
#   ./dev.sh --sync-version     Update all package files from VERSION
#   ./dev.sh --update-manifests Regenerate Manifest-v1.11.toml and Manifest-v1.12.toml

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
BACKEND_DIR="$SCRIPT_DIR/backend"
TAURI_DIR="$SCRIPT_DIR/tauri-app"
VERSION=$(cat "$SCRIPT_DIR/VERSION" | tr -d '[:space:]')

# ============================================================================
# Helpers
# ============================================================================

version_gte() {
    [ "$1" = "$2" ] && return 0
    local IFS=.
    local i ver1=($1) ver2=($2)
    for ((i=${#ver1[@]}; i<${#ver2[@]}; i++)); do ver1[i]=0; done
    for ((i=0; i<${#ver1[@]}; i++)); do
        [[ -z ${ver2[i]} ]] && ver2[i]=0
        ((10#${ver1[i]} > 10#${ver2[i]})) && return 0
        ((10#${ver1[i]} < 10#${ver2[i]})) && return 1
    done
    return 0
}

sync_version() {
    echo "[dev.sh] Syncing version $VERSION to all packages..."

    # frontend/package.json
    cd "$FRONTEND_DIR"
    npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null

    # backend/Project.toml
    sed -i '' "s/^version = \".*\"/version = \"$VERSION\"/" "$BACKEND_DIR/Project.toml"

    # tauri-app/Cargo.toml
    sed -i '' "s/^version = \".*\"/version = \"$VERSION\"/" "$TAURI_DIR/Cargo.toml"

    # tauri-app/tauri.conf.json
    local tmp
    tmp=$(jq --arg v "$VERSION" '.version = $v' "$TAURI_DIR/tauri.conf.json")
    echo "$tmp" > "$TAURI_DIR/tauri.conf.json"

    echo "[dev.sh] All packages set to $VERSION"
}

# ============================================================================
# Version sync mode
# ============================================================================

if [ "${1:-}" = "--sync-version" ]; then
    sync_version
    exit 0
fi

if [ "${1:-}" = "--update-manifests" ]; then
    CHANNELS=$(juliaup status 2>/dev/null | awk 'NR>2 && $0 !~ /^-/ { for(i=1;i<=NF;i++) if ($i ~ /^[0-9]+\.[0-9]+$/ || $i == "release" || $i == "lts") { print $i; break } }')
    if [ -z "$CHANNELS" ]; then
        echo "[dev.sh] Could not detect juliaup channels. Is juliaup installed?"
        exit 1
    fi
    for CHANNEL in $CHANNELS; do
        MINOR=$(julia +${CHANNEL} --version 2>/dev/null | sed 's/julia version \([0-9]*\.[0-9]*\).*/\1/')
        if [ -z "$MINOR" ]; then
            echo "[dev.sh] Could not determine version for channel ${CHANNEL}, skipping."
            continue
        fi
        echo "[dev.sh] Updating Manifest-v${MINOR}.toml (channel: ${CHANNEL})..."
        rm -f "$BACKEND_DIR/Manifest-v${MINOR}.toml"
        touch "$BACKEND_DIR/Manifest-v${MINOR}.toml"
        (cd "$BACKEND_DIR" && julia +${CHANNEL} --project=. -e 'using Pkg; Pkg.resolve(); Pkg.instantiate()')
    done
    exit 0
fi

# ============================================================================
# Prerequisite checks
# ============================================================================

# --- Node.js ---

if ! command -v npm >/dev/null 2>&1; then
    echo "[dev.sh] npm not found. Please install Node.js (>=20.19.0)."
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//')
if ! version_gte "$NODE_VERSION" "20.19.0"; then
    echo "[dev.sh] Node.js $NODE_VERSION is too old. Need >=20.19.0."
    exit 1
fi

# --- Julia ---

if ! command -v julia >/dev/null 2>&1; then
    echo "[dev.sh] julia not found. Please install Julia (>=1.11)."
    exit 1
fi

JULIA_VERSION=$(julia --version | sed 's/julia version //')
if ! version_gte "$JULIA_VERSION" "1.11.0"; then
    echo "[dev.sh] Julia $JULIA_VERSION is too old. Need >=1.11."
    exit 1
fi

# ============================================================================
# Auto-setup
# ============================================================================

# --- Frontend: npm install ---

if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo "[dev.sh] Installing frontend dependencies..."
    (cd "$FRONTEND_DIR" && npm install)
fi

# --- Backend: Julia Pkg setup ---

JULIA_MINOR=$(echo "$JULIA_VERSION" | sed 's/\([0-9]*\.[0-9]*\).*/\1/')
VERSIONED_MANIFEST="$BACKEND_DIR/Manifest-v${JULIA_MINOR}.toml"

if [ ! -f "$VERSIONED_MANIFEST" ] || [ "$BACKEND_DIR/Project.toml" -nt "$VERSIONED_MANIFEST" ]; then
    echo "[dev.sh] Resolving Julia backend dependencies for v${JULIA_MINOR}..."
    rm -f "$VERSIONED_MANIFEST"
    touch "$VERSIONED_MANIFEST"
    (cd "$BACKEND_DIR" && julia --project=. -e 'using Pkg; Pkg.resolve(); Pkg.instantiate()')
fi

# ============================================================================
# Tauri mode
# ============================================================================

if [ "${1:-}" = "--tauri" ]; then
    if ! command -v cargo >/dev/null 2>&1; then
        echo "[dev.sh] cargo not found. Please install Rust: https://rustup.rs"
        exit 1
    fi
    if ! cargo tauri --version >/dev/null 2>&1; then
        echo "[dev.sh] Installing cargo-tauri CLI..."
        cargo install tauri-cli
    fi

    echo "[dev.sh] Starting in Tauri mode..."
    VITE_PORT=1420
    STALE_PID=$(lsof -ti tcp:$VITE_PORT 2>/dev/null || true)
    if [ -n "$STALE_PID" ]; then
        echo "[dev.sh] Killing stale process on port $VITE_PORT (PID $STALE_PID)..."
        kill $STALE_PID 2>/dev/null || true
        sleep 1
    fi
    cd "$TAURI_DIR"
    cargo tauri dev
    exit $?
fi

# ============================================================================
# Browser mode (Vite + Julia)
# ============================================================================

FRONTEND_PID=""
BACKEND_PID=""

cleanup() {
    echo "[dev.sh] Shutting down..."
    [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
    [ -n "$BACKEND_PID"  ] && kill "$BACKEND_PID"  2>/dev/null || true
    exit 0
}
trap cleanup SIGINT SIGTERM EXIT

for PORT in 1420 8000; do
    STALE_PID=$(lsof -ti tcp:$PORT 2>/dev/null || true)
    if [ -n "$STALE_PID" ]; then
        echo "[dev.sh] Killing stale process on port $PORT (PID $STALE_PID)..."
        kill $STALE_PID 2>/dev/null || true
        sleep 1
    fi
done

(cd "$BACKEND_DIR" && julia --threads=auto --project=. run.jl) &
BACKEND_PID=$!

(cd "$FRONTEND_DIR" && npm run dev) &
FRONTEND_PID=$!

# Monitor both processes; if either exits unexpectedly, kill the other
while true; do
    if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
        echo "[dev.sh] Frontend exited. Shutting down backend..."
        exit 1
    fi
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
        echo "[dev.sh] Backend exited. Shutting down frontend..."
        exit 1
    fi
    sleep 2
done
