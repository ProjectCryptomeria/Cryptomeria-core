#!/bin/bash
set -e
source "$(dirname "$0")/../lib/common.sh"

TARGET_CHAIN=$1
GWC_CHAIN="gwc"

# =============================================================================
# 🧩 Functions
# =============================================================================

validate_args() {
    if [ -z "$TARGET_CHAIN" ]; then
        log_error "Usage: $0 <target-chain-id>"
    fi
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

    local balance=$(pod_exec "$pod_name" "$bin_name" q bank balances "$key_addr" -o json | jq -r ".balances[] | select(.denom==\"$DENOM\") | .amount" || echo "0")
    log_info "Balance on $chain ($key_addr): $balance $DENOM"
}

create_link() {
    local path_name=$1
    local src_port=$2
    local dst_port=$3
    local version=$4

    # 既存チェック
    local raw_channels=$(rly_exec q channels "$GWC_CHAIN" 2>/dev/null | jq -s '.' || echo "[]")
    local existing=$(echo "$raw_channels" | jq -r --arg target "$TARGET_CHAIN" --arg port "$src_port" \
        '.[] | select(.port_id==$port and .counterparty.chain_id==$target and .state=="STATE_OPEN") | .channel_id')

    if [ -n "$existing" ] && [ "$existing" != "null" ]; then
        log_info "✅ Link active for $path_name (Channel: $existing). Skipping."
        return 0
    fi

    log_step "Linking path: $path_name ($src_port <-> $dst_port)"
    
    # パス新規作成
    if ! rly_exec paths show "$path_name" >/dev/null 2>&1; then
        rly_exec paths new "$GWC_CHAIN" "$TARGET_CHAIN" "$path_name" --src-port "$src_port" --dst-port "$dst_port" --version "$version"
    fi

    # リンク確立 (リトライ付き)
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
    
    # 既登録チェック
    local registered=$(pod_exec "$gwc_pod" gwcd q gateway endpoints -o json 2>/dev/null | jq -r --arg target "$TARGET_CHAIN" '.storage_infos[] | select(.chain_id==$target) | .chain_id')
    if [ "$registered" == "$TARGET_CHAIN" ]; then
        log_info "✅ Storage for $TARGET_CHAIN is already registered. Skipping."
        return 0
    fi
    
    # Channel ID特定 (待機)
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

    pod_exec "$gwc_pod" gwcd tx gateway register-storage \
        "$channel_id" "$TARGET_CHAIN" "$target_endpoint" \
        --from "local-admin" --chain-id "$GWC_CHAIN" -y --keyring-backend test --home /home/gwc/.gwc || true
}

# =============================================================================
# 🚀 Main Execution
# =============================================================================
validate_args
echo "=== Connecting Chain: $GWC_CHAIN <-> $TARGET_CHAIN ==="
ensure_relayer_pod

check_funds "$GWC_CHAIN"
check_funds "$TARGET_CHAIN"

# 1. Gateway Path (Datastore/Metastore)
DST_PORT_PREFIX="datastore"
if [[ "$TARGET_CHAIN" == *"mdsc"* ]]; then DST_PORT_PREFIX="metastore"; fi

create_link "path-${GWC_CHAIN}-${TARGET_CHAIN}-gw" "gateway" "$DST_PORT_PREFIX" "cryptomeria-1"

# 2. Storage Registration
register_storage_on_gwc

log_success "Connection setup complete for $TARGET_CHAIN"