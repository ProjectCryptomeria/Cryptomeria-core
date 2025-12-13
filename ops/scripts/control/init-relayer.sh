#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

# =============================================================================
# Functions
# =============================================================================

init_config() {
    log_step "Initializing config..."
    if rly_exec test -f /home/relayer/.relayer/config/config.yaml; then
        log_info "Config already exists. Skipping."
    else
        rly_exec config init --memo "Cryptomeria Relayer"
        log_success "Initialized new config."
    fi
}

add_chain_config() {
    local chain_id=$1
    log_step "Adding config for: $chain_id"

    # すでに存在すればスキップ
    if rly_exec chains list | grep -q "$chain_id"; then
        log_info "Chain '$chain_id' already configured."
        return
    fi

    # アドレス解決
    local pod_hostname="${RELEASE_NAME}-${chain_id}-0"
    local rpc_addr="http://${pod_hostname}.${HEADLESS_SERVICE}:26657"
    local grpc_addr="http://${pod_hostname}.${HEADLESS_SERVICE}:9090"

    # Config JSON生成
    local tmp_file="/tmp/${chain_id}.json"
    cat <<EOF | kubectl exec -i -n "$NAMESPACE" "$RELAYER_POD" -- sh -c "cat > $tmp_file"
{
  "type": "cosmos",
  "value": {
    "key": "$RELAYER_KEY",
    "chain-id": "$chain_id",
    "rpc-addr": "$rpc_addr",
    "grpc-addr": "$grpc_addr",
    "account-prefix": "cosmos",
    "keyring-backend": "test",
    "gas-adjustment": 1.5,
    "gas-prices": "0.001$DENOM",
    "debug": true,
    "timeout": "20s",
    "output-format": "json",
    "sign-mode": "direct"
  }
}
EOF

    rly_exec chains add --file "$tmp_file"
    rly_exec rm "$tmp_file"
    log_success "Chain '$chain_id' added."
}

# =============================================================================
# Main Execution
# =============================================================================
echo "=== Initializing Relayer Configuration ==="
ensure_relayer_pod

# 1. Config初期化
init_config

# 2. チェーン追加 (リスト定義)
CHAINS=("gwc" "mdsc" "fdsc-0")
for chain in "${CHAINS[@]}"; do
    add_chain_config "$chain"
done

log_success "Relayer configuration complete."