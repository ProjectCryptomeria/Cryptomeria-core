#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

# =============================================================================
# Functions
# =============================================================================

init_config() {
    log_step "Initializing config..."
    if pod_exec "$RELAYER_POD" test -f /home/relayer/.relayer/config/config.yaml 2>/dev/null; then
        log_info "Config already exists. Skipping."
    else
        rly_exec config init --memo "Cryptomeria Relayer"
        log_success "Initialized new config."
    fi
}

add_chain_config() {
    local chain_id=$1
    log_step "Adding config for: $chain_id"

    if rly_exec chains list 2>/dev/null | grep -q "$chain_id"; then
        log_info "Chain '$chain_id' already configured."
        return
    fi

    local pod_hostname="${RELEASE_NAME}-${chain_id}-0"
    local rpc_addr="http://${pod_hostname}.${HEADLESS_SERVICE}:26657"
    local grpc_addr="http://${pod_hostname}.${HEADLESS_SERVICE}:9090"

    local tmp_file="/tmp/${chain_id}.json"
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

import_relayer_keys() {
    log_step "Importing Relayer keys from mounted secrets..."
    
    # 外部変数 CHAINS (gwc mdsc fdsc-0) をスペース区切りに展開
    local chain_list_str="${CHAINS[*]}"
    
    # Pod内で実行するスクリプト
    # ★修正: ループ展開はHelmで行ったので、ここでは単純に "$chain_id.relayer.mnemonic" を読むだけ
    local script=$(cat <<EOF
    for chain_id in $chain_list_str; do
        
        # ファイル名はChain IDと完全に一致する
        mnemonic_file="/etc/mnemonics/\${chain_id}.relayer.mnemonic"
        
        if [ ! -f "\$mnemonic_file" ]; then
            echo "Warning: Mnemonic file not found for \$chain_id (\$mnemonic_file)"
            continue
        fi
        
        if rly keys show "\$chain_id" "relayer" >/dev/null 2>&1; then
             echo "Skipping \$chain_id (key exists)"
        else
             echo "Restoring key 'relayer' for chain: \$chain_id"
             # ニーモニックを引数として渡す
             rly keys restore "\$chain_id" "relayer" "\$(cat \$mnemonic_file)"
        fi
    done
EOF
    )
    
    pod_exec "$RELAYER_POD" sh -c "$script"
    log_success "Relayer keys imported."
}

# =============================================================================
# Main Execution
# =============================================================================
echo "=== Initializing Relayer Configuration ==="
ensure_relayer_pod

# 1. Config初期化
init_config

# 2. チェーン追加
CHAINS=("gwc" "mdsc" "fdsc-0")
for chain in "${CHAINS[@]}"; do
    add_chain_config "$chain"
done

# 3. キーの一括インポート (シンプル版)
import_relayer_keys

log_success "Relayer configuration complete."