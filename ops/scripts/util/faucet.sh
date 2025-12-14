#!/bin/bash
set -e

# Setup & Configuration
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMMON_LIB="${SCRIPT_DIR}/../lib/common.sh"

# common.shのロード（スタンドアローン対応）
if [ -f "$COMMON_LIB" ]; then
    source "$COMMON_LIB"
else
    NAMESPACE=${NAMESPACE:-"cryptomeria"}
    DENOM="uatom"
    log_step() { echo "--> $1"; }
    log_info() { echo "INFO: $1"; }
    log_error() { echo "❌ $1"; exit 1; }
fi

ADDRESS=$1
AMOUNT=$2
TARGET_CHAIN=${3:-"gwc"}
MILLIONAIRE_KEY="local-admin"

# =============================================================================
# 🧩 Functions
# =============================================================================

usage() {
    echo "Usage: $0 <address> <amount> [chain-id]"
    exit 1
}

format_coin() {
    local amount_str=$1
    if [[ "$amount_str" =~ [[:alpha:]] ]]; then echo "$amount_str"; else echo "${amount_str}${DENOM}"; fi
}

ensure_target_context() {
    local chain_id="$TARGET_CHAIN"
    # common.shの関数があれば使用、なければフォールバック
    if type get_chain_pod_name >/dev/null 2>&1; then
        TARGET_POD=$(get_chain_pod_name "$chain_id")
        BIN_NAME=$(get_chain_bin_name "$chain_id")
        APP_NAME="${BIN_NAME%d}"
    else
        if [ "$chain_id" == "gwc" ]; then
             TARGET_POD=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")
             BIN_NAME="gwcd"
        else
             TARGET_POD="${RELEASE_NAME}-${chain_id}-0"
             BIN_NAME="${chain_id%-[0-9]*}d"
        fi
        APP_NAME="${BIN_NAME%d}"
    fi
    HOME_DIR="/home/${APP_NAME}/.${APP_NAME}"
    export TARGET_POD BIN_NAME HOME_DIR
}

send_faucet() {
    local formatted_amount=$(format_coin "$AMOUNT")
    log_step "💸 Sending $formatted_amount to $ADDRESS on [$TARGET_CHAIN] (from $MILLIONAIRE_KEY)..."
    
    kubectl exec -n "$NAMESPACE" "$TARGET_POD" -- "$BIN_NAME" tx bank send "$MILLIONAIRE_KEY" "$ADDRESS" "$formatted_amount" \
        --chain-id "$TARGET_CHAIN" -y --keyring-backend test --home "$HOME_DIR"
    log_info "✅ Sent!"
}

# =============================================================================
# 🚀 Main Execution
# =============================================================================
if [ -z "$ADDRESS" ] || [ -z "$AMOUNT" ]; then usage; fi
ensure_target_context
send_faucet