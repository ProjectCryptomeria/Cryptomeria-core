#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# show-status.sh
#   - Cryptomeria / GWC / Relayer / Chains status in one place
#
# Requirements (host):
#   - kubectl, jq
# Notes:
#   - Assumes gwcd and rly exist inside their respective pods.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMON_LIB="${SCRIPT_DIR}/../lib/common.sh"

# common.shを利用して設定値を統一（無ければ env / default）
if [[ -f "$COMMON_LIB" ]]; then
  # shellcheck disable=SC1090
  source "$COMMON_LIB"
fi

NAMESPACE="${NAMESPACE:-cryptomeria}"
SHOW_HEIGHT=1
SHOW_BALANCE=1

usage() {
  cat <<'EOF'
Usage: show-status.sh [options]

Options:
  -n, --namespace <ns>   Kubernetes namespace (default: env NAMESPACE or cryptomeria)
      --no-height        Skip block height checks (faster)
      --no-balance       Skip treasury balance check
  -h, --help             Show help
EOF
}

# -----------------------------------------------------------------------------
# Args
# -----------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--namespace)
      NAMESPACE="${2:-}"
      shift 2
      ;;
    --no-height)
      SHOW_HEIGHT=0
      shift
      ;;
    --no-balance)
      SHOW_BALANCE=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# -----------------------------------------------------------------------------
# Dependency checks
# -----------------------------------------------------------------------------
for cmd in kubectl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command not found: $cmd" >&2
    exit 1
  fi
done

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
get_first_pod_by_component() {
  local component="$1"
  kubectl get pods -n "$NAMESPACE" -l "app.kubernetes.io/component=${component}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true
}

safe_jq() {
  # Usage: safe_jq '<jq filter>'
  local filter="$1"
  local out rc
  set +e
  out="$(jq -r "$filter" 2>/dev/null)"
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    return 1
  fi
  printf "%s" "$out"
  return 0
}

get_gw_channel() {
  local chain_id="$1"
  local channels_json="$2" # JSON array

  # port_id=="gateway", counterparty.chain_id==chain_id, state=="STATE_OPEN"
  echo "$channels_json" | jq -r --arg id "$chain_id" '
    .[] | select(.port_id=="gateway"
                 and .counterparty.chain_id==$id
                 and .state=="STATE_OPEN")
    | .channel_id
  ' 2>/dev/null | head -n 1
}

is_registered() {
  local chain_id="$1"
  local registered_json="$2"

  # gwcd q gateway endpoints の JSON に storage_infos[] がある前提
  local found
  found="$(echo "$registered_json" | jq -r --arg id "$chain_id" '
    (.storage_infos // [])[] | select(.chain_id == $id) | .chain_id
  ' 2>/dev/null | head -n 1 || true)"

  if [[ -n "$found" && "$found" != "null" ]]; then
    echo "true"
  else
    echo "false"
  fi
}

get_height_for_pods_csv() {
  # pods_csv: "podA,podB,podC"
  local pods_csv="$1"
  local IFS=','
  read -r -a pods <<< "$pods_csv"
  local pod status_json height

  for pod in "${pods[@]}"; do
    [[ -z "$pod" ]] && continue

    # Try curl inside the pod; parse JSON on host with jq
    status_json="$(kubectl exec -n "$NAMESPACE" "$pod" -- curl -s http://localhost:26657/status 2>/dev/null || true)"
    [[ -z "$status_json" ]] && continue

    height="$(echo "$status_json" | jq -r '.result.sync_info.latest_block_height // empty' 2>/dev/null || true)"
    if [[ -n "$height" && "$height" != "null" ]]; then
      echo "$height"
      return 0
    fi
  done

  echo ""
  return 1
}

# =============================================================================
# Header
# =============================================================================
echo "=== 🩺 Cryptomeria Show Status ==="
echo "Namespace: ${NAMESPACE}"
echo "Date: $(date -Is)"
echo ""

# =============================================================================
# 1) Infrastructure (Relayer / GWC)
# =============================================================================
echo "[1. Infrastructure]"

RELAYER_POD="$(get_first_pod_by_component "relayer")"
if [[ -z "$RELAYER_POD" ]]; then
  echo "❌ Relayer Pod: NOT FOUND"
else
  RLY_PHASE="$(kubectl get pod -n "$NAMESPACE" "$RELAYER_POD" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  echo "✅ Relayer Pod: ${RLY_PHASE:-Unknown} (${RELAYER_POD})"

  # Process check (inside relayer pod)
  if kubectl exec -n "$NAMESPACE" "$RELAYER_POD" -- sh -c "pgrep -f 'rly start' >/dev/null 2>&1"; then
    echo "✅ Relayer Process: Active (rly start)"
  else
    echo "❌ Relayer Process: INACTIVE (rly start not running)"
    echo "   ℹ️  Hint: kubectl logs -n ${NAMESPACE} ${RELAYER_POD}"
  fi
fi

GWC_POD="$(get_first_pod_by_component "gwc")"
if [[ -z "$GWC_POD" ]]; then
  echo "❌ GWC Pod: NOT FOUND"
else
  GWC_PHASE="$(kubectl get pod -n "$NAMESPACE" "$GWC_POD" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  echo "✅ GWC Pod: ${GWC_PHASE:-Unknown} (${GWC_POD})"
fi
echo ""

# =============================================================================
# 2) Treasury (optional)
# =============================================================================
if [[ "$SHOW_BALANCE" -eq 1 ]]; then
  echo "[2. Treasury (GWC - local-admin)]"
  if [[ -z "$GWC_POD" ]]; then
    echo "❌ Skipped: GWC Pod not found."
  else
    ADMIN_ADDR="$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- \
      gwcd keys show local-admin -a --keyring-backend test --home /home/gwc/.gwc 2>/dev/null || true)"

    if [[ -z "$ADMIN_ADDR" ]]; then
      echo "❌ Could not resolve local-admin address."
    else
      BAL_JSON="$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- \
        gwcd q bank balances "$ADMIN_ADDR" -o json 2>/dev/null || true)"

      # denom is environment-dependent; default tries uatom
      BAL_UATOM="$(echo "$BAL_JSON" | jq -r '.balances[]? | select(.denom=="uatom") | .amount' 2>/dev/null | head -n 1 || true)"

      if [[ -n "$BAL_UATOM" && "$BAL_UATOM" != "null" ]]; then
        echo "💰 Admin Balance: $((BAL_UATOM / 1000000)) ATOM (${BAL_UATOM} uatom)"
      else
        echo "⚠️  Balance fetched, but uatom not found (denom may differ) or zero."
      fi
    fi
  fi
  echo ""
fi

# =============================================================================
# 3) Gateway link / Chain status
# =============================================================================
echo "[3. Chains / Gateway Link]"

# Pre-fetch: registered endpoints + channels
REGISTERED_JSON="{}"
RAW_CHANNELS_JSON="[]"

if [[ -n "$GWC_POD" ]]; then
  REGISTERED_JSON="$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- \
    gwcd q gateway endpoints -o json 2>/dev/null || echo "{}")"
fi

if [[ -n "$RELAYER_POD" ]]; then
  raw_channels="$(kubectl exec -n "$NAMESPACE" "$RELAYER_POD" -- rly q channels gwc 2>/dev/null || true)"
  if [[ -n "$raw_channels" ]]; then
    # rly output may be multiple JSON objects; collect to array
    set +e
    RAW_CHANNELS_JSON="$(echo "$raw_channels" | jq -s '.' 2>/dev/null)"
    rc=$?
    set -e
    if [[ $rc -ne 0 || -z "$RAW_CHANNELS_JSON" ]]; then
      RAW_CHANNELS_JSON="[]"
    fi
  fi
fi

# Get chain pods and group by instance
CHAIN_PODS_JSON="$(kubectl get pods -n "$NAMESPACE" -l 'app.kubernetes.io/category=chain' -o json 2>/dev/null || echo '{"items":[]}')"

# Output header
printf "%-18s %-18s %-16s %-18s %-12s %-18s %-12s\n" \
  "CHAIN" "COMPONENTS" "PHASES" "PODS" "HEIGHT" "GW LINK" "GW CHANNEL"
echo "------------------------------------------------------------------------------------------------------------------------"

# instance \t components(csv) \t phases(csv) \t pods(csv)
echo "$CHAIN_PODS_JSON" | jq -r '
  (.items // [])
  | sort_by(.metadata.labels["app.kubernetes.io/instance"])
  | group_by(.metadata.labels["app.kubernetes.io/instance"])
  | .[]
  | [
      (.[0].metadata.labels["app.kubernetes.io/instance"] // "-"),
      (map(.metadata.labels["app.kubernetes.io/component"] // "-") | unique | join(",")),
      (map(.status.phase // "-") | unique | join(",")),
      (map(.metadata.name) | join(","))
    ]
  | @tsv
' | while IFS=$'\t' read -r CHAIN_ID COMPONENTS PHASES PODS_CSV; do
  [[ -z "$CHAIN_ID" || "$CHAIN_ID" == "-" ]] && continue

  # HUB row (gwc itself)
  if [[ "$COMPONENTS" == *"gwc"* || "$CHAIN_ID" == "gwc" ]]; then
    printf "%-18s %-18s %-16s %-18s %-12s %-18s %-12s\n" \
      "$CHAIN_ID" "$COMPONENTS" "$PHASES" "-" "-" "N/A (Hub)" "-"
    continue
  fi

  # Height (optional)
  HEIGHT="-"
  if [[ "$SHOW_HEIGHT" -eq 1 ]]; then
    h="$(get_height_for_pods_csv "$PODS_CSV" || true)"
    if [[ -n "$h" ]]; then
      HEIGHT="$h"
    else
      HEIGHT="N/A"
    fi
  fi

  # GW link / registered
  GW_LINK_STATUS="❌ Not Linked"
  GW_CHANNEL="-"

  gwch="$(get_gw_channel "$CHAIN_ID" "$RAW_CHANNELS_JSON" || true)"
  if [[ -n "$gwch" && "$gwch" != "null" ]]; then
    GW_CHANNEL="$gwch"
    GW_LINK_STATUS="🔗 Linked"
    if [[ "$(is_registered "$CHAIN_ID" "$REGISTERED_JSON")" == "true" ]]; then
      GW_LINK_STATUS="✅ Registered"
    fi
  fi

  # Display pods column compactly: show first pod + count if many
  pods_display="$PODS_CSV"
  if [[ "$PODS_CSV" == *","* ]]; then
    first_pod="${PODS_CSV%%,*}"
    # count
    pod_count=$(( $(tr -cd ',' <<<"$PODS_CSV" | wc -c) + 1 ))
    pods_display="${first_pod} (+$((pod_count-1)))"
  fi

  printf "%-18s %-18s %-16s %-18s %-12s %-18s %-12s\n" \
    "$CHAIN_ID" "$COMPONENTS" "$PHASES" "$pods_display" "$HEIGHT" "$GW_LINK_STATUS" "$GW_CHANNEL"
done

echo ""
echo "=== End ==="
