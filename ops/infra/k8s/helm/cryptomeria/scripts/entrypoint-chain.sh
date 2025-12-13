#!/usr/bin/env bash
set -e

# --- 環境変数と設定 ---
CHAIN_ID=${CHAIN_INSTANCE_NAME}
CHAIN_APP_NAME=${CHAIN_APP_NAME:-datachain}
DENOM="uatom"
USER_HOME="/home/$CHAIN_APP_NAME"
CHAIN_HOME="$USER_HOME/.$CHAIN_APP_NAME"
CHAIN_BINARY="${CHAIN_APP_NAME}d"
MNEMONIC_FILE="/etc/mnemonics/${CHAIN_INSTANCE_NAME}.mnemonic"

# --- 固定アカウント定義 (Phase 1 Requirement) ---
MILLIONAIRE_MNEMONIC="veteran what limit claw lizard grab echo pull sunset rain charge honey grain fiction sister pink category car sugar vital special obvious opinion burden"
LOCAL_ADMIN_MNEMONIC="absent error journey slot broccoli cross beef silver disorder air knife this oil camera response indicate pond inmate tunnel ostrich orbit change page bronze"

# --- 初期化完了フラグ ---
# これが存在しない場合、初期化が不完全とみなしてやり直す
INIT_FLAG="$CHAIN_HOME/init_complete_v1"

# --- 初期化処理 ---
if [ ! -f "$INIT_FLAG" ]; then
    echo "--- ⚠️ No complete initialization found. Starting fresh setup for $CHAIN_ID... ---"
    
    # 既存の不完全なデータを削除 (重要)
    rm -rf "$CHAIN_HOME/config" "$CHAIN_HOME/data" "$CHAIN_HOME/keyring-test"
    mkdir -p "$CHAIN_HOME"

    echo "--- Initializing chain: $CHAIN_ID (type: $CHAIN_APP_NAME) ---"
    $CHAIN_BINARY init "$CHAIN_ID" --chain-id "$CHAIN_ID" --home "$CHAIN_HOME"

    # 1. 鍵の復元
    SHARED_MNEMONIC=$(cat "$MNEMONIC_FILE")
    
    echo "$SHARED_MNEMONIC" | $CHAIN_BINARY keys add validator --recover --keyring-backend=test --home "$CHAIN_HOME" --hd-path "m/44'/118'/0'/0/0"
    echo "$SHARED_MNEMONIC" | $CHAIN_BINARY keys add relayer --recover --keyring-backend=test --home "$CHAIN_HOME" --hd-path "m/44'/118'/0'/0/1"
    echo "$SHARED_MNEMONIC" | $CHAIN_BINARY keys add creator --recover --keyring-backend=test --home "$CHAIN_HOME" --hd-path "m/44'/118'/0'/0/2"

    VALIDATOR_ADDR=$($CHAIN_BINARY keys show validator -a --keyring-backend=test --home "$CHAIN_HOME")
    RELAYER_ADDR=$($CHAIN_BINARY keys show relayer -a --keyring-backend=test --home "$CHAIN_HOME")
    CREATOR_ADDR=$($CHAIN_BINARY keys show creator -a --keyring-backend=test --home "$CHAIN_HOME")

    # 2. Millionaireアカウントの追加
    echo "--- Importing Millionaire Account ---"
    echo "$MILLIONAIRE_MNEMONIC" | $CHAIN_BINARY keys add millionaire --recover --keyring-backend=test --home "$CHAIN_HOME"
    MILLIONAIRE_ADDR=$($CHAIN_BINARY keys show millionaire -a --keyring-backend=test --home "$CHAIN_HOME")
    
    # 3. Local Adminアカウントの追加
    echo "--- Importing Local Admin Account ---"
    echo "$LOCAL_ADMIN_MNEMONIC" | $CHAIN_BINARY keys add local-admin --recover --keyring-backend=test --home "$CHAIN_HOME"
    LOCAL_ADMIN_ADDR=$($CHAIN_BINARY keys show local-admin -a --keyring-backend=test --home "$CHAIN_HOME")

    # 4. Genesisへのアカウント追加
    $CHAIN_BINARY genesis add-genesis-account "$VALIDATOR_ADDR" 1000000000000"$DENOM" --home "$CHAIN_HOME"
    $CHAIN_BINARY genesis add-genesis-account "$MILLIONAIRE_ADDR" 100000000000"$DENOM" --home "$CHAIN_HOME"
    $CHAIN_BINARY genesis add-genesis-account "$LOCAL_ADMIN_ADDR" 10000"$DENOM" --home "$CHAIN_HOME"
    $CHAIN_BINARY genesis add-genesis-account "$RELAYER_ADDR" 100000000000"$DENOM" --home "$CHAIN_HOME"
    $CHAIN_BINARY genesis add-genesis-account "$CREATOR_ADDR" 100000000000"$DENOM" --home "$CHAIN_HOME"

    # Gentxの生成と収集 (ここが失敗すると再起動時にループしていた)
    echo "--- Generating Gentx ---"
    $CHAIN_BINARY genesis gentx validator 1000000000"$DENOM" \
        --keyring-backend=test \
        --chain-id "$CHAIN_ID" \
        --home "$CHAIN_HOME" 2>&1

    echo "--- Collecting Gentxs ---"
    $CHAIN_BINARY genesis collect-gentxs --home "$CHAIN_HOME" 2>&1

    echo "--- Validating genesis file ---"
    $CHAIN_BINARY genesis validate --home "$CHAIN_HOME"

    # 設定ファイルの書き換え
    CONFIG_TOML="$CHAIN_HOME/config/config.toml"
    APP_TOML="$CHAIN_HOME/config/app.toml"
    
    sed -i 's/laddr = "tcp:\/\/127.0.0.1:26657"/laddr = "tcp:\/\/0.0.0.0:26657"/' "$CONFIG_TOML"
    sed -i 's/cors_allowed_origins = \[\]/cors_allowed_origins = \["\*"\]/' "$CONFIG_TOML"
    sed -i 's/^max_body_bytes = .*/max_body_bytes = 10737418240/' "$CONFIG_TOML"
    sed -i 's/^max_tx_bytes = .*/max_tx_bytes = 10737418240/' "$CONFIG_TOML"
    sed -i 's/^size = .*/size = 50000/' "$CONFIG_TOML"
    sed -i 's/^max_txs_bytes = .*/max_txs_bytes = 10737418240/' "$CONFIG_TOML"
    sed -i 's/^timeout_broadcast_tx_commit = .*/timeout_broadcast_tx_commit = "60s"/' "$CONFIG_TOML"

    sed -i '/\[api\]/,/\[/{s/enable = false/enable = true/}' "$APP_TOML"
    sed -i '/\[api\]/,/\[/{s/address = "tcp:\/\/localhost:1317"/address = "tcp:\/\/0.0.0.0:1317"/}' "$APP_TOML"
    sed -i '/\[api\]/a max-request-body-size = 10737418240' "$APP_TOML"
    sed -i '/\[grpc\]/,/\[/{s/enable = false/enable = true/}' "$APP_TOML"
    sed -i 's/^max-recv-msg-size = .*/max-recv-msg-size = "10737418240"/' "$APP_TOML"
    sed -i 's/^max-send-msg-size = .*/max-send-msg-size = "10737418240"/' "$APP_TOML"
    sed -i '/\[grpc-web\]/,/\[/{s/enable = false/enable = true/}' "$APP_TOML"

    # 全て成功したらフラグを作成
    touch "$INIT_FLAG"
    echo "--- Initialization complete for $CHAIN_ID ---"
fi

# --- ノードの起動 ---
START_CMD="$CHAIN_BINARY start --home $CHAIN_HOME --minimum-gas-prices=0$DENOM --log_level error --log_format json"

if [ "$DEV_MODE" = "true" ]; then
    echo "=================================================="
    echo "🚧 DEVELOPMENT MODE: Hot Reload Enabled"
    echo "=================================================="
    while true; do
        echo "--> 🚀 Starting node for $CHAIN_ID..."
        $START_CMD &
        PID=$!
        wait $PID || true
        EXIT_CODE=$?
        echo "--> ⚠️  Node process exited with code $EXIT_CODE."
        echo "--> 🔄 Restarting in 1 second..."
        sleep 1
    done
else
    echo "--- Starting node for $CHAIN_ID (Production) ---"
    exec $START_CMD
fi