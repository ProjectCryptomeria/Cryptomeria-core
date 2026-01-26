{{- define "cryptomeria.scripts.entrypoint" -}}
#!/usr/bin/env bash
set -e

# =============================================================================
# 🛠️ Configuration
# =============================================================================
CHAIN_ID=${CHAIN_INSTANCE_NAME}
CHAIN_APP_NAME=${CHAIN_APP_NAME}
DENOM="uatom"
USER_HOME="/home/$CHAIN_APP_NAME"
CHAIN_HOME="$USER_HOME/.$CHAIN_APP_NAME"
CHAIN_BINARY="${CHAIN_APP_NAME}d"
INIT_FLAG="$CHAIN_HOME/init_complete_v5"
EXECUTOR_NAME="local-admin"
GENESIS_URL="http://cryptomeria-genesis-server/${CHAIN_ID}.json"

log_step() { echo "--> $1"; }

# =============================================================================
# 🚀 Startup Logic
# =============================================================================

if [ ! -f "$INIT_FLAG" ]; then
    log_step "Starting Initialization for $CHAIN_ID..."

    if [ -d "$CHAIN_HOME/config" ]; then
        log_step "Existing config found. Checking consistency..."
        if [ -f "$CHAIN_HOME/config/genesis.json" ]; then
             log_step "Data exists. Skipping Init."
             touch "$INIT_FLAG"
        else
             log_step "Incomplete data. Wiping..."
             rm -rf "$CHAIN_HOME/config" "$CHAIN_HOME/data"
        fi
    fi

    if [ ! -f "$INIT_FLAG" ]; then
        log_step "Downloading Genesis from $GENESIS_URL..."
        
        $CHAIN_BINARY init $CHAIN_ID --chain-id $CHAIN_ID --home $CHAIN_HOME >/dev/null 2>&1 || true
        
        MAX_RETRIES=30
        COUNT=0
        while [ $COUNT -lt $MAX_RETRIES ]; do
            # genesis.json のダウンロード
            if curl -s -f -o "$CHAIN_HOME/config/genesis.json" "$GENESIS_URL"; then
                echo "✅ Genesis downloaded."
                
                # バリデータ鍵のダウンロードと配置
                KEY_URL="http://cryptomeria-genesis-server/${CHAIN_ID}-priv_validator_key.json"
                echo "--> Downloading Validator Key from $KEY_URL..."
                if curl -s -f -o "$CHAIN_HOME/config/priv_validator_key.json" "$KEY_URL"; then
                    echo "✅ Validator Key downloaded/restored."
                else
                    echo "❌ Failed to download validator key."
                    exit 1
                fi
                
                break
            fi
            echo "⏳ Waiting for Genesis Server... ($COUNT/$MAX_RETRIES)"
            sleep 2
            COUNT=$((COUNT+1))
        done

        if [ $COUNT -eq $MAX_RETRIES ]; then
            echo "❌ Failed to download genesis."
            exit 1
        fi

        touch "$INIT_FLAG"
    fi
fi

# executor鍵の自動インポート (Dev用) 
MNEMONIC_FILE="/etc/mnemonics/${CHAIN_ID}.${EXECUTOR_NAME}.mnemonic"

if [ -f "$MNEMONIC_FILE" ]; then
    log_step "Importing executor key from $MNEMONIC_FILE..."
    # 鍵のインポートを実行
    $CHAIN_BINARY keys add $EXECUTOR_NAME --recover --keyring-backend test --home $CHAIN_HOME < $MNEMONIC_FILE >/dev/null 2>&1 || true

    # ▼▼▼ 追加: executorをGenesisのパラメータに設定する処理 ▼▼▼
    if [ "$CHAIN_BINARY" == "gwcd" ]; then
        log_step "Configuring gateway executor in genesis.json..."
        
        # インポートした鍵のアドレスを取得
        ADMIN_ADDR=$($CHAIN_BINARY keys show $EXECUTOR_NAME -a --keyring-backend test --home $CHAIN_HOME)
        
        if [ -n "$ADMIN_ADDR" ]; then
            # さきほど実装した SetLocalAdminCmd を実行して genesis.json を更新
            $CHAIN_BINARY genesis set-local-admin "$ADMIN_ADDR" --home "$CHAIN_HOME"
            
            # 実行権限などの環境変数もセット
            export GWC_GATEWAY_AUTHORITY="$ADMIN_ADDR"
            echo "🔧 [Genesis Update] executor set to: $ADMIN_ADDR"
            echo "🔧 [Env Override] GWC_GATEWAY_AUTHORITY set to: $GWC_GATEWAY_AUTHORITY"
        else
            echo "❌ Failed to retrieve executor address."
            exit 1
        fi
    fi
    # ▲▲▲ 追加ここまで ▲▲▲
else
    log_step "No mnemonic found at $MNEMONIC_FILE. Skipping key import and admin configuration."
fi

# --- Hot Reload対応ループ ---
echo "--- Starting node loop for $CHAIN_ID (Port: 26657/1317/9090) ---"

# シグナルハンドリング（コンテナ停止時は正しく終了させる）
trap 'kill -TERM $PID; wait $PID' TERM INT

while true; do
    echo "🚀 Launching $CHAIN_BINARY..."
    # バックグラウンドで起動してPIDを取得
    $CHAIN_BINARY start --home $CHAIN_HOME --log_level error --log_format json &
    PID=$!
    
    # プロセス終了を待機
    wait $PID
    EXIT_CODE=$?
    
    echo "⚠️ Node stopped with exit code $EXIT_CODE. Restarting in 1s..."
    sleep 1
done
{{- end -}}