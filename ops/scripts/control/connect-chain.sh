#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

TARGET_CHAIN=$1
if [ -z "$TARGET_CHAIN" ]; then
    log_error "Usage: $0 <target-chain-id>"
fi

GWC_CHAIN="gwc"

# =============================================================================
# Functions
# =============================================================================

check_funds() {
    local chain=$1
    local pod_name="${RELEASE_NAME}-${chain}-0"
    if [[ "$chain" == "gwc" ]]; then 
        pod_name=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")
    fi
    
    local key_addr=$(rly_exec keys show "$chain" "relayer" 2>/dev/null || echo "unknown")
    if [ "$key_addr" == "unknown" ]; then
        log_warn "Key 'relayer' not found on Relayer for $chain. Did init-relayer.sh run correctly?"
        return
    fi

    local bin_name="${chain%-[0-9]*}d"
    local balance=$(pod_exec "$pod_name" "$bin_name" q bank balances "$key_addr" -o json | jq -r ".balances[] | select(.denom==\"$DENOM\") | .amount" || echo "0")
    log_info "Balance on $chain ($key_addr): $balance $DENOM"
}

create_link() {
    local path_name=$1
    local src_port=$2
    local dst_port=$3
    local version=$4

    # 既存リンク(Active Channel)の確認
    local raw_channels=$(rly_exec q channels "$GWC_CHAIN" 2>/dev/null | jq -s '.' || echo "[]")
    
    local existing_channel=$(echo "$raw_channels" | jq -r --arg target "$TARGET_CHAIN" --arg port "$src_port" \
        '.[] | select(.port_id==$port and .counterparty.chain_id==$target and .state=="STATE_OPEN") | .channel_id')

    if [ -n "$existing_channel" ] && [ "$existing_channel" != "null" ]; then
        log_info "✅ Link already active for $path_name (Channel: $existing_channel). Skipping."
        return 0
    fi

    log_step "Linking path: $path_name ($src_port <-> $dst_port)"
    
    if ! rly_exec paths show "$path_name" >/dev/null 2>&1; then
        rly_exec paths new "$GWC_CHAIN" "$TARGET_CHAIN" "$path_name" --src-port "$src_port" --dst-port "$dst_port" --version "$version"
    fi

    # ▼▼▼ リトライロジック付きリンク作成 ▼▼▼
    local max_retries=5
    local count=1
    local success=0

    while [ $count -le $max_retries ]; do
        echo "   🔄 Attempt $count/$max_retries to link $path_name..."
        
        if rly_exec transact link "$path_name" --src-port "$src_port" --dst-port "$dst_port" --version "$version"; then
            log_success "Path linked: $path_name"
            success=1
            break
        else
            log_warn "Link command failed. Waiting 10s before retry..."
            sleep 10
        fi
        
        count=$((count + 1))
    done

    if [ $success -eq 0 ]; then
        log_error "Failed to create link for $path_name after $max_retries attempts."
        exit 1
    fi
}

register_storage_on_gwc() {
    log_step "Registering storage on GWC..."

    local gwc_pod=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")
    
    local registered_check=$(pod_exec "$gwc_pod" gwcd q gateway endpoints -o json 2>/dev/null | jq -r --arg target "$TARGET_CHAIN" '.storage_infos[] | select(.chain_id==$target) | .chain_id')
    
    if [ "$registered_check" == "$TARGET_CHAIN" ]; then
        log_info "✅ Storage for $TARGET_CHAIN is already registered. Skipping transaction."
        return 0
    fi
    
    # チャネルID取得のリトライ
    local channel_id=""
    for i in {1..5}; do
        local raw=$(rly_exec q channels "$GWC_CHAIN" 2>/dev/null | jq -s '.' || echo "[]")
        channel_id=$(echo "$raw" | jq -r --arg target "$TARGET_CHAIN" '.[] | select(.port_id=="gateway" and .counterparty.chain_id==$target) | .channel_id' | tail -n 1)
        
        if [ -n "$channel_id" ] && [ "$channel_id" != "null" ]; then
            break
        fi
        echo "   ⏳ Waiting for Gateway Channel ID to appear... ($i/5)"
        sleep 3
    done

    if [ -z "$channel_id" ] || [ "$channel_id" == "null" ]; then
        log_warn "Channel ID not found for $TARGET_CHAIN. Skipping registration."
        return
    fi

    log_info "Found Channel ID: $channel_id. Registering..."
    local target_endpoint="http://${RELEASE_NAME}-${TARGET_CHAIN}-0.${HEADLESS_SERVICE}:1317"

    # ▼▼▼ 修正: local-admin からトランザクションを実行 ▼▼▼
    pod_exec "$gwc_pod" gwcd tx gateway register-storage \
        "$channel_id" "$TARGET_CHAIN" "$target_endpoint" \
        --from "local-admin" --chain-id "$GWC_CHAIN" -y --keyring-backend test --home /home/gwc/.gwc || true
}

# =============================================================================
# Main Execution
# =============================================================================
echo "=== Connecting Chain: $GWC_CHAIN <-> $TARGET_CHAIN ==="
ensure_relayer_pod

check_funds "$GWC_CHAIN"
check_funds "$TARGET_CHAIN"

# Gateway Path
DST_PORT_PREFIX="datastore"
if [[ "$TARGET_CHAIN" == *"mdsc"* ]]; then DST_PORT_PREFIX="metastore"; fi
create_link "path-${GWC_CHAIN}-${TARGET_CHAIN}-gw" "gateway" "$DST_PORT_PREFIX" "cryptomeria-1"

# Transfer Path
sleep 5
create_link "path-${GWC_CHAIN}-${TARGET_CHAIN}-tf" "transfer" "transfer" "ics20-1"

# Storage Registration
register_storage_on_gwc

log_success "Connection setup complete for $TARGET_CHAIN"