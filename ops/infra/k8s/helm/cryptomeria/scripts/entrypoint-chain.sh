#!/usr/bin/env bash
set -e

# =============================================================================
# 🛠️ Configuration
# =============================================================================
CHAIN_ID=${CHAIN_INSTANCE_NAME}      # e.g., fdsc-0, gwc
CHAIN_APP_NAME=${CHAIN_APP_NAME}     # e.g., fdsc, gwc
DENOM="uatom"
USER_HOME="/home/$CHAIN_APP_NAME"
CHAIN_HOME="$USER_HOME/.$CHAIN_APP_NAME"
CHAIN_BINARY="${CHAIN_APP_NAME}d"
INIT_FLAG="$CHAIN_HOME/init_complete_v4"

# ニーモニックファイルのパス定義
MNEMONIC_DIR="/etc/mnemonics"

# Chain ID (インスタンス名) ベースのファイル名を参照する
ADMIN_KEY_FILE="${MNEMONIC_DIR}/${CHAIN_ID}.local-admin.mnemonic"
RELAYER_KEY_FILE="${MNEMONIC_DIR}/${CHAIN_ID}.relayer.mnemonic"

# GWCのみ: MillionaireはChain ID (gwc) に紐づく
MILLIONAIRE_KEY_FILE="${MNEMONIC_DIR}/${CHAIN_ID}.millionaire.mnemonic"

# =============================================================================
# 🧩 Helper Functions
# =============================================================================
log_step() { echo "--> $1"; }

import_key_from_file() {
    local name=$1
    local file=$2
    
    # ログは標準エラー出力へ (変数に入れないため)
    if [ ! -f "$file" ]; then
        echo "❌ Error: Mnemonic file for '$name' not found at $file" >&2
        ls -l "$MNEMONIC_DIR" >&2
        return 1
    fi

    echo "   Importing key: $name from $file" >&2
    
    # 一時ファイルを使ってログをキャプチャ (成功時は捨て、失敗時は表示)
    local tmp_log=$(mktemp)

    # 1. 鍵の復元
    if ! cat "$file" | $CHAIN_BINARY keys add $name --recover --keyring-backend=test --home "$CHAIN_HOME" >"$tmp_log" 2>&1; then
        echo "❌ Critical Error: Failed to add key '$name'." >&2
        cat "$tmp_log" >&2
        rm -f "$tmp_log"
        return 1
    fi
    
    # 2. アドレス取得
    # -a フラグは使わず、--output json のみを使用
    if ! $CHAIN_BINARY keys show $name --keyring-backend=test --home "$CHAIN_HOME" --output json >"$tmp_log" 2>&1; then
        echo "❌ Critical Error: Failed to show key '$name'." >&2
        cat "$tmp_log" >&2
        rm -f "$tmp_log"
        return 1
    fi

    # jq でパース
    local address=$(cat "$tmp_log" | jq -r .address)
    rm -f "$tmp_log"

    if [ -z "$address" ] || [ "$address" == "null" ]; then
        echo "❌ Critical Error: Parsed address is empty or null for '$name'." >&2
        return 1
    fi

    # 成功したアドレスのみを標準出力に返す
    echo "$address"
    return 0
}

add_genesis_account() {
    local addr=$1
    local amount=$2
    
    if [ -z "$addr" ]; then
        echo "❌ Error: Attempted to add genesis account with empty address" >&2
        exit 1
    fi

    $CHAIN_BINARY genesis add-genesis-account "$addr" "$amount" --home "$CHAIN_HOME"
}

# =============================================================================
# 🏗️ Setup Logic
# =============================================================================

step_init_chain() {
    log_step "Initializing chain: $CHAIN_ID"
    rm -rf "$CHAIN_HOME/config" "$CHAIN_HOME/data" "$CHAIN_HOME/keyring-test"
    mkdir -p "$CHAIN_HOME"
    $CHAIN_BINARY init "$CHAIN_ID" --chain-id "$CHAIN_ID" --home "$CHAIN_HOME" >/dev/null 2>&1
}

step_setup_accounts() {
    log_step "Setting up accounts from mnemonics..."

    # 1. Local Admin (Validator)
    local admin_addr=$(import_key_from_file "local-admin" "$ADMIN_KEY_FILE")
    # ★重要: サブシェルでのエラーを検知してメインスクリプトを止める
    if [ -z "$admin_addr" ]; then
        echo "❌ Failed to setup local-admin account. Exiting."
        exit 1
    fi
    add_genesis_account "$admin_addr" "10000000000000$DENOM"

    # 2. Relayer
    local relayer_addr=$(import_key_from_file "relayer" "$RELAYER_KEY_FILE")
    if [ -z "$relayer_addr" ]; then
        echo "❌ Failed to setup relayer account. Exiting."
        exit 1
    fi
    add_genesis_account "$relayer_addr" "10000000000$DENOM"

    # # 3. Millionaire (GWC Only)
    # if [ "$CHAIN_APP_NAME" == "gwc" ]; then
    #     local millionaire_addr=$(import_key_from_file "millionaire" "$MILLIONAIRE_KEY_FILE")
    #     if [ -z "$millionaire_addr" ]; then
    #         echo "❌ Failed to setup millionaire account. Exiting."
    #         exit 1
    #     fi
    #     echo "   💰 Allocating 100B uatom to Millionaire..."
    #     add_genesis_account "$millionaire_addr" "100000000000$DENOM"
    # fi
}

step_create_validator() {
    log_step "Generating Gentx (Validator: local-admin)..."
    $CHAIN_BINARY genesis gentx local-admin "10000000000000$DENOM" \
        --keyring-backend=test \
        --chain-id "$CHAIN_ID" \
        --home "$CHAIN_HOME" 2>&1 >/dev/null

    log_step "Collecting Gentxs..."
    $CHAIN_BINARY genesis collect-gentxs --home "$CHAIN_HOME" 2>&1 >/dev/null
    $CHAIN_BINARY genesis validate --home "$CHAIN_HOME"
}

step_configure_node() {
    log_step "Configuring node (sed)..."
    local config_toml="$CHAIN_HOME/config/config.toml"
    local app_toml="$CHAIN_HOME/config/app.toml"
    
    sed -i 's/laddr = "tcp:\/\/127.0.0.1:26657"/laddr = "tcp:\/\/0.0.0.0:26657"/' "$config_toml"
    sed -i 's/cors_allowed_origins = \[\]/cors_allowed_origins = \["\*"\]/' "$config_toml"
    sed -i 's/^timeout_broadcast_tx_commit = .*/timeout_broadcast_tx_commit = "60s"/' "$config_toml"
    
    sed -i '/\[api\]/,/\[/{s/enable = false/enable = true/}' "$app_toml"
    sed -i '/\[api\]/,/\[/{s/address = "tcp:\/\/localhost:1317"/address = "tcp:\/\/0.0.0.0:1317"/}' "$app_toml"
    sed -i '/\[grpc\]/,/\[/{s/enable = false/enable = true/}' "$app_toml"
    sed -i '/\[grpc-web\]/,/\[/{s/enable = false/enable = true/}' "$app_toml"
    
    # Large TX support
    sed -i 's/^max_body_bytes = .*/max_body_bytes = 10737418240/' "$config_toml"
    sed -i 's/^max_tx_bytes = .*/max_tx_bytes = 10737418240/' "$config_toml"
    sed -i 's/^max_txs_bytes = .*/max_txs_bytes = 10737418240/' "$config_toml"
    sed -i '/\[api\]/a max-request-body-size = 10737418240' "$app_toml"
    sed -i 's/^max-recv-msg-size = .*/max-recv-msg-size = "10737418240"/' "$app_toml"
    sed -i 's/^max-send-msg-size = .*/max-send-msg-size = "10737418240"/' "$app_toml"
}

# =============================================================================
# 🚀 Execution
# =============================================================================

if [ ! -f "$INIT_FLAG" ]; then
    step_init_chain
    step_setup_accounts
    step_create_validator
    step_configure_node
    touch "$INIT_FLAG"
    echo "--- ✅ Initialization complete ---"
fi

echo "--- Starting node for $CHAIN_ID ---"
exec $CHAIN_BINARY start --home $CHAIN_HOME --minimum-gas-prices=0$DENOM --log_level error --log_format json