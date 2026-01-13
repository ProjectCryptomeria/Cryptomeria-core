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
                
                # ▼▼▼ 追加: バリデータ鍵のダウンロードと配置 ▼▼▼
                KEY_URL="http://cryptomeria-genesis-server/${CHAIN_ID}-priv_validator_key.json"
                echo "--> Downloading Validator Key from $KEY_URL..."
                if curl -s -f -o "$CHAIN_HOME/config/priv_validator_key.json" "$KEY_URL"; then
                    echo "✅ Validator Key downloaded/restored."
                else
                    echo "❌ Failed to download validator key."
                    exit 1
                fi
                # ▲▲▲ 追加ここまで ▲▲▲
                
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

echo "--- Starting node for $CHAIN_ID (Port: 26657/1317/9090) ---"
exec $CHAIN_BINARY start --home $CHAIN_HOME --log_level info --log_format json
{{- end -}}