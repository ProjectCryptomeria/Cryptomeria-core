#!/usr/bin/env bash
set -euo pipefail

# This file provides shared helpers for performance tests.
# It is intended to be sourced by each test script.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../../../" && pwd)"

# shellcheck source=/dev/null
source "${ROOT_DIR}/ops/scripts/lib/common.sh"

# Namespace override (default matches the rest of ops scripts)
NAMESPACE="${NAMESPACE:-cryptomeria}"

require_cmd() {
  local missing=0
  for c in "$@"; do
    if ! command -v "$c" >/dev/null 2>&1; then
      echo "❌ missing required command: $c" >&2
      missing=1
    fi
  done
  if [ "$missing" -ne 0 ]; then
    exit 1
  fi
}

gwc_pod() {
  kubectl -n "$NAMESPACE" get pod -l app.kubernetes.io/component=gwc -o jsonpath='{.items[0].metadata.name}'
}

relayer_pod() {
  kubectl -n "$NAMESPACE" get pod -l app.kubernetes.io/component=relayer -o jsonpath='{.items[0].metadata.name}'
}

mdsc_pod() {
  kubectl -n "$NAMESPACE" get pod -l app.kubernetes.io/component=mdsc -o jsonpath='{.items[0].metadata.name}'
}

stop_relayer() {
  local pod
  pod="$(relayer_pod)"
  # Stop any running relayer process. Ignore errors (e.g., not running).
  kubectl -n "$NAMESPACE" exec "$pod" -- sh -c "pkill -f 'rly start' 2>/dev/null || true; pkill -x rly 2>/dev/null || true" >/dev/null 2>&1 || true
}

start_relayer() {
  # Prefer the repo's canonical start script for consistent behavior.
  if [ -x "${ROOT_DIR}/ops/scripts/control/start-relayer.sh" ]; then
    "${ROOT_DIR}/ops/scripts/control/start-relayer.sh"
    return 0
  fi

  # Fallback: start inside the relayer pod.
  local pod
  pod="$(relayer_pod)"
  kubectl -n "$NAMESPACE" exec "$pod" -- sh -c "( /bin/relayer-start.sh 2>/dev/null || /bin/start-relayer.sh 2>/dev/null || rly start ) >/dev/null 2>&1 &" >/dev/null 2>&1 || true
}

wait_manifest() {
  local project="$1"
  local timeout_s="${2:-240}"

  local pod
  pod="$(mdsc_pod)"

  local start
  start="$(date +%s)"
  while true; do
    if kubectl -n "$NAMESPACE" exec "$pod" -- mdscd q metastore get-manifest "$project" -o json >/dev/null 2>&1; then
      return 0
    fi

    if [ "$(( $(date +%s) - start ))" -ge "$timeout_s" ]; then
      echo "❌ timeout waiting manifest: project=$project" >&2
      return 1
    fi

    echo "waiting manifest..."
    sleep 1
  done
}

wait_tx_committed() {
  local txhash="$1"
  local timeout_s="${2:-120}"

  local pod
  pod="$(gwc_pod)"

  local start
  start="$(date +%s)"
  while true; do
    if kubectl -n "$NAMESPACE" exec "$pod" -- gwcd q tx "$txhash" -o json >/dev/null 2>&1; then
      return 0
    fi

    if [ "$(( $(date +%s) - start ))" -ge "$timeout_s" ]; then
      echo "❌ timeout waiting tx commit: txhash=$txhash" >&2
      return 1
    fi

    sleep 1
  done
}

# Backward/short alias used by test scripts
wait_tx_commit() {
  wait_tx_committed "$@"
}
