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

ensure_key() {
    local chain=$1
    local key_name=$RELAYER_KEY
    
    if ! rly_exec keys show "$chain" "$key_name" >/dev/null 2>&1; then
        log_step "Creating key '$key_name' on $chain..."
        rly_exec keys add "$chain" "$key_name"
    else
        log_info "Key '$key_name' exists on $chain."
    fi
}

ensure_funds() {
    local chain=$1
    local pod_name="${RELEASE_NAME}-${chain}-0"
    # gwcの場合はpod名が違うので補正（gwcはStatefulSet名が特殊でない限り）
    if [[ "$chain" == "gwc" ]]; then pod_name=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}"); fi

    local key_addr=$(rly_exec keys show "$chain" "$RELAYER_KEY")
    local bin_name="${chain%-[0-9]*}d" # fdsc-0 -> fdscd

    # 残高確認
    local balance=$(pod_exec "$pod_name" "$bin_name" q bank balances "$key_addr" -o json | jq -r ".balances[] | select(.denom==\"$DENOM\") | .amount" || echo "0")
    if [ -z "$balance" ]; then balance=0; fi

    if [ "$balance" -lt "10000000" ]; then
        log_step "Funding $key_addr on $chain..."
        pod_exec "$pod_name" "$bin_name" tx bank send "$MILLIONAIRE_KEY" "$key_addr" "100000000${DENOM}" -y --chain-id "$chain" --keyring-backend test --home "/home/${chain%-[0-9]*}/.${chain%-[0-9]*}"
        sleep 5
    else
        log_info "Balance OK ($balance) on $chain."
    fi
}

create_link() {
    local path_name=$1
    local src_port=$2
    local dst_port=$3
    local version=$4

    log_step "Linking path: $path_name ($src_port <-> $dst_port)"
    
    # パス設定の作成（なければ）
    if ! rly_exec paths show "$path_name" >/dev/null 2>&1; then
        rly_exec paths new "$GWC_CHAIN" "$TARGET_CHAIN" "$path_name" --src-port "$src_port" --dst-port "$dst_port" --version "$version"
    fi

    # リンク確立
    if rly_exec transact link "$path_name" --src-port "$src_port" --dst-port "$dst_port" --version "$version"; then
        log_success "Path linked: $path_name"
    else
        log_warn "Link command returned code. Checking if already linked..."
    fi
}

register_storage_on_gwc() {
    log_step "Registering storage on GWC..."
    
    # GatewayポートのチャネルIDを検索
    local raw=$(rly_exec q channels "$GWC_CHAIN")
    local channel_id=$(echo "$raw" | jq -r --arg target "$TARGET_CHAIN" 'select(.port_id=="gateway" and .counterparty.chain_id==$target) | .channel_id' | tail -n 1)

    if [ -z "$channel_id" ] || [ "$channel_id" == "null" ]; then
        log_warn "Channel ID not found for $TARGET_CHAIN. Skipping registration."
        return
    fi

    log_info "Found Channel ID: $channel_id"
    local target_endpoint="http://${RELEASE_NAME}-${TARGET_CHAIN}-0.${HEADLESS_SERVICE}:1317"
    local gwc_pod=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")

    pod_exec "$gwc_pod" gwcd tx gateway register-storage \
        "$channel_id" "$TARGET_CHAIN" "$target_endpoint" \
        --from "$MILLIONAIRE_KEY" --chain-id "$GWC_CHAIN" -y --keyring-backend test --home /home/gwc/.gwc || true
}

# =============================================================================
# Main Execution
# =============================================================================
echo "=== Connecting Chain: $GWC_CHAIN <-> $TARGET_CHAIN ==="
ensure_relayer_pod

# 1. 鍵の準備
ensure_key "$GWC_CHAIN"
ensure_key "$TARGET_CHAIN"

# 2. 資金注入
ensure_funds "$GWC_CHAIN"
ensure_funds "$TARGET_CHAIN"

# 3. リンクの作成
# Gateway Path
DST_PORT_PREFIX="datastore"
if [[ "$TARGET_CHAIN" == *"mdsc"* ]]; then DST_PORT_PREFIX="metastore"; fi
create_link "path-${GWC_CHAIN}-${TARGET_CHAIN}-gw" "gateway" "$DST_PORT_PREFIX" "cryptomeria-1"

# Transfer Path
create_link "path-${GWC_CHAIN}-${TARGET_CHAIN}-tf" "transfer" "transfer" "ics20-1"

# 4. ストレージ登録
sleep 5
register_storage_on_gwc

log_success "Connection setup complete for $TARGET_CHAIN"