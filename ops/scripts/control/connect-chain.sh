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

# 資金チェック (表示のみ、自動補充なし)
# ※キーは init-relayer.sh でインポート済みという前提
check_funds() {
    local chain=$1
    local pod_name="${RELEASE_NAME}-${chain}-0"
    if [[ "$chain" == "gwc" ]]; then 
        pod_name=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")
    fi
    
    # Relayer上のキーアドレスを取得
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

    log_step "Linking path: $path_name ($src_port <-> $dst_port)"
    
    # パス設定の作成（なければ）
    if ! rly_exec paths show "$path_name" >/dev/null 2>&1; then
        rly_exec paths new "$GWC_CHAIN" "$TARGET_CHAIN" "$path_name" --src-port "$src_port" --dst-port "$dst_port" --version "$version"
    fi

    # リンク確立
    # 冪等性を考慮し、エラーが出ても続行する（既にリンク済みの可能性があるため）
    if rly_exec transact link "$path_name" --src-port "$src_port" --dst-port "$dst_port" --version "$version"; then
        log_success "Path linked: $path_name"
    else
        log_warn "Link command returned code. Checking if already linked..."
    fi
}

register_storage_on_gwc() {
    log_step "Registering storage on GWC..."
    
    # GatewayポートのチャネルIDを検索 (jq -s でJSON配列として安全に処理)
    local raw=$(rly_exec q channels "$GWC_CHAIN" 2>/dev/null | jq -s '.' || echo "[]")
    local channel_id=$(echo "$raw" | jq -r --arg target "$TARGET_CHAIN" '.[] | select(.port_id=="gateway" and .counterparty.chain_id==$target) | .channel_id' | tail -n 1)

    if [ -z "$channel_id" ] || [ "$channel_id" == "null" ]; then
        log_warn "Channel ID not found for $TARGET_CHAIN. Skipping registration."
        return
    fi

    log_info "Found Channel ID: $channel_id"
    local target_endpoint="http://${RELEASE_NAME}-${TARGET_CHAIN}-0.${HEADLESS_SERVICE}:1317"
    local gwc_pod=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")

    # GWCの登録トランザクションも、Millionaireから送金
    # GWCのMillionaireキーは、entrypoint-chain.shで作成されたものを使用
    # キーリングバックエンド test, ホームディレクトリ指定必須
    pod_exec "$gwc_pod" gwcd tx gateway register-storage \
        "$channel_id" "$TARGET_CHAIN" "$target_endpoint" \
        --from "millionaire" --chain-id "$GWC_CHAIN" -y --keyring-backend test --home /home/gwc/.gwc || true
}

# =============================================================================
# Main Execution
# =============================================================================
echo "=== Connecting Chain: $GWC_CHAIN <-> $TARGET_CHAIN ==="
ensure_relayer_pod

# 1. 資金状況確認
check_funds "$GWC_CHAIN"
check_funds "$TARGET_CHAIN"

# 2. リンクの作成
# Gateway Path
DST_PORT_PREFIX="datastore"
if [[ "$TARGET_CHAIN" == *"mdsc"* ]]; then DST_PORT_PREFIX="metastore"; fi
create_link "path-${GWC_CHAIN}-${TARGET_CHAIN}-gw" "gateway" "$DST_PORT_PREFIX" "cryptomeria-1"

# Transfer Path
create_link "path-${GWC_CHAIN}-${TARGET_CHAIN}-tf" "transfer" "transfer" "ics20-1"

# 3. ストレージ登録
sleep 5
register_storage_on_gwc

log_success "Connection setup complete for $TARGET_CHAIN"