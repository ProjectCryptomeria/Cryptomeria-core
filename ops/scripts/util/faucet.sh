#!/bin/bash
set -e

# =============================================================================
# 🛠️ Setup & Configuration
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMMON_LIB="${SCRIPT_DIR}/../control/lib/common.sh"

if [ -f "$COMMON_LIB" ]; then
    source "$COMMON_LIB"
else
    NAMESPACE=${NAMESPACE:-"cryptomeria"}
    DENOM="uatom"
    # common.sh がない場合のフォールバックも local-admin に
    MILLIONAIRE_KEY="local-admin"
    log_step() { echo "--> $1"; }
    log_info() { echo "INFO: $1"; }
    log_error() { echo "❌ $1"; exit 1; }
fi

ADDRESS=$1
AMOUNT=$2
TARGET_CHAIN=${3:-"gwc"}

# =============================================================================
# 🧩 Functions
# =============================================================================

usage() {
    echo "Usage: $0 <address> <amount> [chain-id]"
    echo "Example: $0 cosmos1... 10000uatom fdsc-0"
    exit 1
}

format_coin() {
    local amount_str=$1
    if [[ "$amount_str" =~ [[:alpha:]] ]]; then
        echo "$amount_str"
    else
        echo "${amount_str}${DENOM}"
    fi
}

ensure_target_context() {
    local chain_id="$TARGET_CHAIN"
    
    # Pod名とバイナリ名の特定
    if [ "$chain_id" == "gwc" ]; then
        TARGET_POD=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")
        APP_NAME="gwc"
    else
        TARGET_POD="${RELEASE_NAME}-${chain_id}-0"
        APP_NAME="${chain_id%-[0-9]*}" # fdsc-0 -> fdsc
    fi
    
    BIN_NAME="${APP_NAME}d"
    HOME_DIR="/home/${APP_NAME}/.${APP_NAME}"
    
    if [ -z "$TARGET_POD" ]; then
        log_error "Target Pod not found for chain '$chain_id'."
    fi
    export TARGET_POD BIN_NAME HOME_DIR
}

send_faucet() {
    local formatted_amount=$(format_coin "$AMOUNT")
    # ▼▼▼ 修正: $MILLIONAIRE_KEY (local-admin) を使用してローカル送金 ▼▼▼
    log_step "💸 Sending $formatted_amount to $ADDRESS on [$TARGET_CHAIN] (from $MILLIONAIRE_KEY)..."
    
    kubectl exec -n "$NAMESPACE" "$TARGET_POD" -- "$BIN_NAME" tx bank send "$MILLIONAIRE_KEY" "$ADDRESS" "$formatted_amount" \
        --chain-id "$TARGET_CHAIN" -y --keyring-backend test --home "$HOME_DIR"
    
    log_info "✅ Sent! Check balance: just accounts"
}

# =============================================================================
# 🚀 Main Execution
# =============================================================================

if [ -z "$ADDRESS" ] || [ -z "$AMOUNT" ]; then usage; fi

ensure_target_context
send_faucet