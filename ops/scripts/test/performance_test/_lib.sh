#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

# shellcheck source=/dev/null
source "$ROOT_DIR/ops/scripts/lib/common.sh"

require_cmd() {
  local c
  for c in "$@"; do
    if ! command -v "$c" >/dev/null 2>&1; then
      echo "❌ Required command not found: $c" >&2
      exit 127
    fi
  done
}

gwc_pod() {
  kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/component=gwc -o jsonpath='{.items[0].metadata.name}'
}

mdsc_pod() {
  kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/component=mdsc -o jsonpath='{.items[0].metadata.name}'
}

relayer_pod() {
  kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/component=relayer -o jsonpath='{.items[0].metadata.name}'
}

wait_manifest() {
  local project="$1"
  local timeout_s="${2:-180}"
  local started
  started="$(date +%s)"
  local pod
  pod="$(mdsc_pod)"

  while true; do
    if kubectl exec -n "$NAMESPACE" "$pod" -- mdscd q metastore get-manifest "$project" -o json >/dev/null 2>&1; then
      return 0
    fi

    if (( $(date +%s) - started > timeout_s )); then
      echo "❌ Timeout waiting manifest for project=$project" >&2
      return 1
    fi

    echo "waiting manifest..."
    sleep 1
  done
}

stop_relayer() {
  local pod
  pod="$(relayer_pod)"
  kubectl exec -n "$NAMESPACE" "$pod" -- sh -c "pkill -x rly || true"
}

is_relayer_running() {
  local pod
  pod="$(relayer_pod)"
  kubectl exec -n "$NAMESPACE" "$pod" -- sh -c "pgrep -f 'rly start' >/dev/null 2>&1"
}

start_relayer() {
  (cd "$ROOT_DIR" && ./ops/scripts/control/start-relayer.sh)
}
