#!/bin/bash
set -e
source "$(dirname "$0")/../lib/common.sh"

# =============================================================================
# 🧩 Functions
# =============================================================================

# Configファイルの初期化
init_config() {
    log_step "Initializing config..."
    if pod_exec "$RELAYER_POD" test -f /home/relayer/.relayer/config/config.yaml 2>/dev/null; then
        log_info "Config already exists. Skipping."
    else
        rly_exec config init --memo "Cryptomeria Relayer"
        log_success "Initialized new config."
    fi
}

# 実行中のチェーンを検出
detect_chains() {
    log_step "Detecting running chain nodes..."
    
    local detected_ids=$(kubectl get pods -n "$NAMESPACE" \
        -l "app.kubernetes.io/category=chain" \
        --field-selector=status.phase=Running \
        -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/instance}{"\n"}{end}' | sort | uniq)

    if [ -z "$detected_ids" ]; then
        log_error "No running chain pods found."
    fi

    mapfile -t CHAINS <<< "$detected_ids"
    log_info "Detected Chains: ${CHAINS[*]}"
}

# [Internal] 個別チェーンの設定追加
_add_chain_config() {
    local chain_id=$1
    
    if rly_exec chains list 2>/dev/null | grep -q "$chain_id"; then
        log_info "Chain '$chain_id' already configured."
        return
    fi

    local pod_hostname="${RELEASE_NAME}-${chain_id}-0"
    local rpc_addr="http://${pod_hostname}.${HEADLESS_SERVICE}:26657"
    local grpc_addr="http://${pod_hostname}.${HEADLESS_SERVICE}:9090"
    local tmp_file="/tmp/${chain_id}.json"

    # 設定JSON生成
    cat <<EOF | kubectl exec -i -n "$NAMESPACE" "$RELAYER_POD" -- sh -c "cat > $tmp_file"
{
  "type": "cosmos",
  "value": {
    "key": "relayer",
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
    pod_exec "$RELAYER_POD" rm "$tmp_file"
    log_success "Chain '$chain_id' added."
}

# 全チェーンの設定登録
register_chains() {
    log_step "Registering chains to Relayer..."
    for chain in "${CHAINS[@]}"; do
        if [ -n "$chain" ]; then
            _add_chain_config "$chain"
        fi
    done
}

# 鍵の一括インポート
import_keys() {
    log_step "Importing Relayer keys..."
    local chain_list_str="${CHAINS[*]}"
    
    local script=$(cat <<EOF
    for chain_id in $chain_list_str; do
        if [ -z "\$chain_id" ]; then continue; fi
        mnemonic_file="/etc/mnemonics/\${chain_id}.relayer.mnemonic"
        if [ ! -f "\$mnemonic_file" ]; then
            echo "Warning: Mnemonic file not found for \$chain_id"
            continue
        fi
        if rly keys show "\$chain_id" "relayer" >/dev/null 2>&1; then
             echo "Skipping \$chain_id (key exists)"
        else
             echo "Restoring key 'relayer' for chain: \$chain_id"
             rly keys restore "\$chain_id" "relayer" "\$(cat \$mnemonic_file)"
        fi
    done
EOF
    )
    pod_exec "$RELAYER_POD" sh -c "$script"
    log_success "Relayer keys imported."
}

# =============================================================================
# 🚀 Main Execution
# =============================================================================
echo "=== Initializing Relayer Configuration ==="
ensure_relayer_pod

init_config
detect_chains
register_chains
import_keys

log_success "Relayer configuration complete."