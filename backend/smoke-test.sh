#!/usr/bin/env bash
# Smoke test: boots the Julia backend, loads a schedule, runs a simulation,
# and verifies it completes successfully.
#
# Usage:  ./backend/smoke-test.sh
# Exit:   0 on success, 1 on failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=$((10000 + RANDOM % 50000))
BASE_URL="http://127.0.0.1:${PORT}"
SERVER_PID=""
HEALTH_TIMEOUT=300   # seconds — Julia precompilation can be slow
SIM_TIMEOUT=120      # seconds

# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

cleanup() {
    if [[ -n "${SERVER_PID}" ]]; then
        kill "${SERVER_PID}" 2>/dev/null || true
        wait "${SERVER_PID}" 2>/dev/null || true
    fi
}
trap cleanup EXIT

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

ok() {
    echo "OK:   $1"
}

# ------------------------------------------------------------------
# 1. Start the backend
# ------------------------------------------------------------------

echo "Starting Julia backend on port ${PORT} ..."
julia --project="${SCRIPT_DIR}" "${SCRIPT_DIR}/run.jl" 127.0.0.1 "${PORT}" &
SERVER_PID=$!

# ------------------------------------------------------------------
# 2. Wait for /health
# ------------------------------------------------------------------

echo "Waiting for /health (timeout ${HEALTH_TIMEOUT}s) ..."
elapsed=0
while (( elapsed < HEALTH_TIMEOUT )); do
    if curl -sf "${BASE_URL}/health" > /dev/null 2>&1; then
        ok "/health responded after ${elapsed}s"
        break
    fi
    sleep 2
    elapsed=$(( elapsed + 2 ))
done
(( elapsed >= HEALTH_TIMEOUT )) && fail "/health did not respond within ${HEALTH_TIMEOUT}s"

# ------------------------------------------------------------------
# 3. List schedules
# ------------------------------------------------------------------

schedules=$(curl -sf "${BASE_URL}/schedules")
[[ -z "${schedules}" ]] && fail "GET /schedules returned empty response"
ok "GET /schedules returned: ${schedules}"

# ------------------------------------------------------------------
# 4. Run simulation with minimal.schedule.json
# ------------------------------------------------------------------

SPEC_FILE="${SCRIPT_DIR}/examples/minimal.schedule.json"
[[ -f "${SPEC_FILE}" ]] || fail "Example schedule not found: ${SPEC_FILE}"
SPEC=$(cat "${SPEC_FILE}")

# Build JSON payload (spec is embedded as a JSON string)
PAYLOAD=$(jq -n \
    --arg name "minimal" \
    --arg spec "${SPEC}" \
    '{ schedule_name: $name, schedule_spec: $spec, max_time: 0.0, subscribed_species: [] }')

echo "Starting simulation ..."
run_response=$(curl -sf -X POST "${BASE_URL}/simulations/run" \
    -H "Content-Type: application/json" \
    -d "${PAYLOAD}")
[[ -z "${run_response}" ]] && fail "POST /simulations/run returned empty response"

sim_id=$(echo "${run_response}" | jq -r '.id')
[[ -z "${sim_id}" || "${sim_id}" == "null" ]] && fail "No simulation id in response: ${run_response}"
ok "Simulation started: ${sim_id}"

# ------------------------------------------------------------------
# 5. Poll until completed
# ------------------------------------------------------------------

echo "Polling simulation status (timeout ${SIM_TIMEOUT}s) ..."
elapsed=0
while (( elapsed < SIM_TIMEOUT )); do
    status_response=$(curl -sf "${BASE_URL}/simulations/${sim_id}")
    status=$(echo "${status_response}" | jq -r '.status')

    case "${status}" in
        completed)
            ok "Simulation completed after ${elapsed}s"
            break
            ;;
        failed|error)
            error_msg=$(echo "${status_response}" | jq -r '.error // "unknown"')
            fail "Simulation failed: ${error_msg}"
            ;;
        *)
            sleep 2
            elapsed=$(( elapsed + 2 ))
            ;;
    esac
done
(( elapsed >= SIM_TIMEOUT )) && fail "Simulation did not complete within ${SIM_TIMEOUT}s"

# ------------------------------------------------------------------
# Done
# ------------------------------------------------------------------

echo ""
echo "Smoke test passed."
