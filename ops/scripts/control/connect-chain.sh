#!/bin/bash
set -ex
source "$(dirname "$0")/../lib/common.sh"

TARGET_CHAIN=$1
GWC_CHAIN="gwc"

validate_args() {
    if [ -z "$TARGET_CHAIN" ]; then
        log_error "Usage: $0 <target-chain-id>"
    fi
}

wait_for_rpc() {
    local chain=$1
    local pod_name=$(get_chain_pod_name "$chain")
    local bin_name=$(get_chain_bin_name "$chain")
    log_info "⏳ Waiting for $chain RPC to be ready..."
    until pod_exec "$pod_name" "$bin_name" status >/dev/null 2>&1; do
        sleep 2
    done
    log_success "$chain RPC is ready."
}

check_funds() {
    local chain=$1
    local pod_name=$(get_chain_pod_name "$chain")
    local bin_name=$(get_chain_bin_name "$chain")
    
    local key_addr=$(rly_exec keys show "$chain" "relayer" 2>/dev/null || echo "unknown")
    if [ "$key_addr" == "unknown" ]; then
        log_warn "Key 'relayer' not found for $chain."
        return
    fi

    # 修正: balances配列から denom が一致するものを取得
    local balance=$(pod_exec "$pod_name" "$bin_name" q bank balances "$key_addr" -o json | jq -r --arg denom "$DENOM" '.balances[] | select(.denom==$denom) | .amount' || echo "0")
    
    # 結果が空または null の場合は 0 に安全にフォールバック
    if [ -z "$balance" ] || [ "$balance" == "null" ]; then
        balance="0"
    fi

    log_info "Balance on $chain ($key_addr): $balance $DENOM"
}

create_link() {
    local path_name=$1
    local src_port=$2
    local dst_port=$3
    local version=$4

    local raw_channels=$(rly_exec q channels "$GWC_CHAIN" 2>/dev/null | jq -s '.' || echo "[]")
    local existing=$(echo "$raw_channels" | jq -r --arg target "$TARGET_CHAIN" --arg port "$src_port" \
        '.[] | select(.port_id==$port and .counterparty.chain_id==$target and .state=="STATE_OPEN") | .channel_id')

    if [ -n "$existing" ] && [ "$existing" != "null" ]; then
        log_info "✅ Link active for $path_name (Channel: $existing). Skipping."
        return 0
    fi

    log_step "Linking path: $path_name ($src_port <-> $dst_port)"
    
    if ! rly_exec paths show "$path_name" >/dev/null 2>&1; then
        rly_exec paths new "$GWC_CHAIN" "$TARGET_CHAIN" "$path_name" --src-port "$src_port" --dst-port "$dst_port" --version "$version"
    fi

    local max_retries=5
    for ((i=1; i<=max_retries; i++)); do
        echo "   🔄 Attempt $i/$max_retries..."
        if rly_exec transact link "$path_name" --src-port "$src_port" --dst-port "$dst_port" --version "$version"; then
            log_success "Path linked: $path_name"
            return 0
        fi
        sleep 10
    done

    log_error "Failed to create link for $path_name."
}

register_storage_on_gwc() {
    log_step "Registering storage on GWC..."
    local gwc_pod=$(get_chain_pod_name "gwc")
    
    local registered=$(pod_exec "$gwc_pod" gwcd q gateway endpoints -o json 2>/dev/null | jq -r --arg target "$TARGET_CHAIN" '.storage_infos[] | select(.chain_id==$target) | .chain_id')
    if [ "$registered" == "$TARGET_CHAIN" ]; then
        log_info "✅ Storage for $TARGET_CHAIN is already registered. Skipping."
        return 0
    fi
    
    local channel_id=""
    for i in {1..5}; do
        local raw=$(rly_exec q channels "$GWC_CHAIN" 2>/dev/null | jq -s '.' || echo "[]")
        channel_id=$(echo "$raw" | jq -r --arg target "$TARGET_CHAIN" '.[] | select(.port_id=="gateway" and .counterparty.chain_id==$target) | .channel_id' | tail -n 1)
        
        if [ -n "$channel_id" ] && [ "$channel_id" != "null" ]; then
            break
        fi
        echo "   ⏳ Waiting for Gateway Channel ID... ($i/5)"
        sleep 3
    done

    if [ -z "$channel_id" ] || [ "$channel_id" == "null" ]; then
        log_warn "Channel ID not found for $TARGET_CHAIN. Skipping registration."
        return
    fi

    log_info "Found Channel ID: $channel_id. Registering..."
    local target_endpoint="http://${RELEASE_NAME}-${TARGET_CHAIN}-0.${HEADLESS_SERVICE}:1317"

    # --- 修正箇所：--gas-prices の単位を uatom に、出力を JSON (-o json) に変更 ---
    local output
    output=$(pod_exec "$gwc_pod" gwcd tx gateway register-storage \
        "$channel_id" "$TARGET_CHAIN" "$target_endpoint" "$DST_PORT_PREFIX" \
        --from "local-admin" --chain-id "$GWC_CHAIN" \
        --gas auto --gas-adjustment 1.5 --gas-prices 0.1uatom \
        --broadcast-mode sync -o json \
        -y --keyring-backend test --home /home/gwc/.gwc)
    
    local status=$?
    
    # 修正: jq で code フィールドを抽出して判定
    local tx_code=$(echo "$output" | jq -r '.code // -1')

    if [ "$status" -eq 0 ] && [ "$tx_code" -eq 0 ]; then
        log_success "✅ Registered storage info for $channel_id ($TARGET_CHAIN)"
    else
        log_error "❌ Transaction failed (Code: $tx_code). Check authority or funds."
        echo "Debug Output: $output"
        exit 1
    fi
}

# --- メイン処理：RPC 待機を追加 ---
validate_args
echo "=== Connecting Chain: $GWC_CHAIN <-> $TARGET_CHAIN ==="
ensure_relayer_pod

# RPC が起動するのを待ってから処理を開始
wait_for_rpc "$GWC_CHAIN"
wait_for_rpc "$TARGET_CHAIN"

check_funds "$GWC_CHAIN"
check_funds "$TARGET_CHAIN"

DST_PORT_PREFIX="datastore"
if [[ "$TARGET_CHAIN" == *"mdsc"* ]]; then DST_PORT_PREFIX="metastore"; fi

create_link "path-${GWC_CHAIN}-${TARGET_CHAIN}-gw" "gateway" "$DST_PORT_PREFIX" "cryptomeria-1"

register_storage_on_gwc

log_success "Connection setup complete for $TARGET_CHAIN"