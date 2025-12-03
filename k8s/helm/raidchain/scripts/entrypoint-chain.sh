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
TX_SIZE_COST_PER_BYTE=0 # 1バイトあたりのコストを研究実験のために0に設定 (以前は1)

# --- 初期化処理 ---
if [ ! -d "$CHAIN_HOME/config" ]; then
    echo "--- Initializing chain: $CHAIN_ID (type: $CHAIN_APP_NAME) ---"

    # 初期化
    $CHAIN_BINARY init "$CHAIN_ID" --chain-id "$CHAIN_ID" --home "$CHAIN_HOME"

    # 鍵の復元と追加
    SHARED_MNEMONIC=$(cat "$MNEMONIC_FILE")
    
    # HD Pathを明示的に指定して、TypeScript(cosmjs)側の仕様と完全に一致させる
    echo "$SHARED_MNEMONIC" | $CHAIN_BINARY keys add validator --recover --keyring-backend=test --home "$CHAIN_HOME" --hd-path "m/44'/118'/0'/0/0"
    echo "$SHARED_MNEMONIC" | $CHAIN_BINARY keys add relayer --recover --keyring-backend=test --home "$CHAIN_HOME" --hd-path "m/44'/118'/0'/0/1"
    echo "$SHARED_MNEMONIC" | $CHAIN_BINARY keys add creator --recover --keyring-backend=test --home "$CHAIN_HOME" --hd-path "m/44'/118'/0'/0/2"

    VALIDATOR_ADDR=$($CHAIN_BINARY keys show validator -a --keyring-backend=test --home "$CHAIN_HOME")
    RELAYER_ADDR=$($CHAIN_BINARY keys show relayer -a --keyring-backend=test --home "$CHAIN_HOME")
    CREATOR_ADDR=$($CHAIN_BINARY keys show creator -a --keyring-backend=test --home "$CHAIN_HOME")

    # ジェネシスアカウントの追加
    $CHAIN_BINARY genesis add-genesis-account "$VALIDATOR_ADDR" 1000000000000"$DENOM" --home "$CHAIN_HOME"

    # Gentxの生成と収集
    $CHAIN_BINARY genesis gentx validator 1000000000"$DENOM" \
        --keyring-backend=test \
        --chain-id "$CHAIN_ID" \
        --home "$CHAIN_HOME"

    $CHAIN_BINARY genesis collect-gentxs --home "$CHAIN_HOME"

    $CHAIN_BINARY genesis add-genesis-account "$RELAYER_ADDR" 100000000000"$DENOM" --home "$CHAIN_HOME"
    $CHAIN_BINARY genesis add-genesis-account "$CREATOR_ADDR" 100000000000"$DENOM" --home "$CHAIN_HOME"

    echo "--- Validating genesis file ---"
    $CHAIN_BINARY genesis validate --home "$CHAIN_HOME"

    CONFIG_TOML="$CHAIN_HOME/config/config.toml"
    APP_TOML="$CHAIN_HOME/config/app.toml"
    
    # --- config.toml の設定変更 (上限を150MBに引き上げ) ---
    sed -i 's/laddr = "tcp:\/\/127.0.0.1:26657"/laddr = "tcp:\/\/0.0.0.0:26657"/' "$CONFIG_TOML"
    sed -i 's/cors_allowed_origins = \[\]/cors_allowed_origins = \["\*"\]/' "$CONFIG_TOML"
    sed -i 's/^max_body_bytes = .*/max_body_bytes = 10737418240/' "$CONFIG_TOML" # 150MB
    sed -i 's/^max_tx_bytes = .*/max_tx_bytes = 10737418240/' "$CONFIG_TOML"   # 150MB
    
    # Mempoolのサイズを増やす (デフォルト: 5000)
    sed -i 's/^size = .*/size = 50000/' "$CONFIG_TOML"
    # Mempoolにキャッシュできる最大バイト数を増やす (デフォルト: 1GB)
    sed -i 's/^max_txs_bytes = .*/max_txs_bytes = 10737418240/' "$CONFIG_TOML" # 10GB
    # トランザクションブロードキャストのコミット完了までのタイムアウトを延長 (デフォルト: 10s)
    sed -i 's/^timeout_broadcast_tx_commit = .*/timeout_broadcast_tx_commit = "60s"/' "$CONFIG_TOML"

    # --- app.toml の設定変更 ---


    # API, gRPCの有効化と設定 (上限を150MBに引き上げ)
    sed -i '/\[api\]/,/\[/{s/enable = false/enable = true/}' "$APP_TOML"
    sed -i '/\[api\]/,/\[/{s/address = "tcp:\/\/localhost:1317"/address = "tcp:\/\/0.0.0.0:1317"/}' "$APP_TOML"
    sed -i '/\[api\]/a max-request-body-size = 10737418240' "$APP_TOML" # 150MB
    sed -i '/\[grpc\]/,/\[/{s/enable = false/enable = true/}' "$APP_TOML"
    
    sed -i 's/^max-recv-msg-size = .*/max-recv-msg-size = "10737418240"/' "$APP_TOML"
    sed -i 's/^max-send-msg-size = .*/max-send-msg-size = "10737418240"/' "$APP_TOML"
    
    sed -i '/\[grpc-web\]/,/\[/{s/enable = false/enable = true/}' "$APP_TOML"

    # --- GWC Specific Configuration ---
    if [ "$CHAIN_APP_NAME" = "gwc" ]; then
        echo "--- Configuring GWC endpoints in app.toml ---"
        cat <<EOF >> "$APP_TOML"

[gwc]
mdsc_endpoint = "http://raidchain-mdsc-headless:1317"
chunk_size = 10240
[gwc.fdsc_endpoints]
fdsc = "http://raidchain-fdsc-0-headless:1317"
fdsc-0 = "http://raidchain-fdsc-0-headless:1317"
fdsc-1 = "http://raidchain-fdsc-1-headless:1317"
EOF
    fi

    echo "--- Initialization complete for $CHAIN_ID ---"
fi

# --- ノードの起動 (ホットリロード対応) ---

# 実行するコマンドライン引数を変数に格納
START_CMD="$CHAIN_BINARY start --home $CHAIN_HOME --minimum-gas-prices=0$DENOM --log_level error --log_format json"

if [ "$DEV_MODE" = "true" ]; then
    echo "=================================================="
    echo "🚧 DEVELOPMENT MODE: Hot Reload Enabled"
    echo "=================================================="
    echo "   Running '$CHAIN_BINARY' inside a loop."
    echo "   Use 'just hot-reload' to update the binary."
    echo "=================================================="

    # 無限ループでノードを実行
    while true; do
        echo "--> 🚀 Starting node for $CHAIN_ID..."
        
        # バックグラウンドで実行
        $START_CMD &
        PID=$!
        
        # プロセス終了を待機 (killall された場合やクラッシュした場合)
        # set -e が効いているため、waitが失敗扱いにならないように || true をつける
        wait $PID || true
        EXIT_CODE=$?
        
        echo "--> ⚠️  Node process exited with code $EXIT_CODE."
        echo "--> 🔄 Restarting in 1 second..."
        sleep 1
    done
else
    # 本番モード: 通常通り exec で実行 (PID 1 を引き継ぐ)
    echo "--- Starting node for $CHAIN_ID (Production) ---"
    exec $START_CMD
fi