#!/bin/bash
set -e

# =============================================================================
# 🛠️ Setup & Configuration
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMMON_LIB="${SCRIPT_DIR}/../control/lib/common.sh"

# common.sh があれば読み込み、なければ簡易変数を設定
if [ -f "$COMMON_LIB" ]; then
    source "$COMMON_LIB"
else
    NAMESPACE=${NAMESPACE:-"cryptomeria"}
    DENOM="uatom"
    log_info() { echo "INFO: $1"; }
    log_step() { echo "--> $1"; }
    log_warn() { echo "⚠️  $1"; }
    log_error() { echo "❌ $1"; exit 1; }
fi

# 引数取得
ADDRESS=$1
AMOUNT=$2
TARGET_CHAIN=${3:-"gwc"} # Default to gwc

# =============================================================================
# 🧩 Functions
# =============================================================================

usage() {
    echo "Usage: $0 <address> <amount> [chain-id]"
    echo "Example (Local): $0 cosmos1... 10000uatom"
    echo "Example (IBC):   $0 cosmos1... 10000uatom fdsc-0"
    echo "Note: Amount must include denomination (e.g., 10000uatom)."
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

ensure_gwc_pod() {
    GWC_POD=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")
    if [ -z "$GWC_POD" ]; then
        log_error "GWC Pod not found. Is the system running?"
    fi
}

send_local() {
    local formatted_amount=$(format_coin "$AMOUNT")
    log_step "💸 Sending $formatted_amount to $ADDRESS on [GWC] (Local Bank Send)..."
    
    kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd tx bank send millionaire "$ADDRESS" "$formatted_amount" \
        --chain-id gwc -y --keyring-backend test --home /home/gwc/.gwc

    log_info "✅ Sent! Check balance with: just shell gwc -> gwcd q bank balances $ADDRESS"
}

get_transfer_channel() {
    if ! type ensure_relayer_pod >/dev/null 2>&1; then
        log_error "Cannot use relayer utils. Ensure common.sh is loaded correctly."
    fi
    ensure_relayer_pod
    
    local raw_channels=$(kubectl exec -n "$NAMESPACE" "$RELAYER_POD" -- rly q channels gwc 2>/dev/null | jq -s '.' || echo "[]")
    
    CHANNEL_ID=$(echo "$raw_channels" | jq -r --arg target "$TARGET_CHAIN" \
        '.[] | select(.port_id=="transfer" and .counterparty.chain_id==$target and .state=="STATE_OPEN") | .channel_id' | head -n 1)

    if [ -z "$CHANNEL_ID" ] || [ "$CHANNEL_ID" == "null" ]; then
        log_error "No open transfer channel found from gwc to $TARGET_CHAIN. Did you run 'just start-system'?"
    fi
    
    log_info "ℹ️  Using IBC Channel: $CHANNEL_ID"
}

send_ibc() {
    local formatted_amount=$(format_coin "$AMOUNT")
    log_step "💸 Sending $formatted_amount to $ADDRESS on [$TARGET_CHAIN] via IBC..."
    
    get_transfer_channel

    # 1. 送金トランザクション実行
    kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd tx ibc-transfer transfer transfer "$CHANNEL_ID" "$ADDRESS" "$formatted_amount" \
        --from millionaire --chain-id gwc -y --keyring-backend test --home /home/gwc/.gwc

    log_info "✅ IBC Packet Sent! Waiting for block inclusion..."
    
    # ブロック生成を待つ
    sleep 6

    # 2. Relayerによる強制配信 (Flush)
    # パス名は connect-chain.sh の命名規則 "path-gwc-{CHAIN}-tf" に従う
    local path_name="path-gwc-${TARGET_CHAIN}-tf"
    
    log_step "🔄 Flushing packets via Relayer ($path_name)..."
    
    # フラッシュ実行 (失敗してもスクリプトを止めない)
    if kubectl exec -n "$NAMESPACE" "$RELAYER_POD" -- rly transact flush "$path_name"; then
        log_info "✅ Packets relayed successfully."
    else
        log_warn "Flush command returned error. Packets might be already relayed or path name mismatch."
        log_warn "You can try flushing manually: just shell relayer -> rly transact flush $path_name"
    fi
}

# =============================================================================
# 🚀 Main Execution
# =============================================================================

if [ -z "$ADDRESS" ] || [ -z "$AMOUNT" ]; then usage; fi
ensure_gwc_pod

if [ "$TARGET_CHAIN" == "gwc" ]; then
    send_local
else
    send_ibc
fi