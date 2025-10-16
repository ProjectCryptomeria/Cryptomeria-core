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
    $CHAIN_BINARY genesis add-genesis-account "$RELAYER_ADDR" 100000000000"$DENOM" --home "$CHAIN_HOME"
    $CHAIN_BINARY genesis add-genesis-account "$CREATOR_ADDR" 100000000000"$DENOM" --home "$CHAIN_HOME"

    # Gentxの生成と収集
    $CHAIN_BINARY genesis gentx validator 1000000000"$DENOM" \
        --keyring-backend=test \
        --chain-id "$CHAIN_ID" \
        --home "$CHAIN_HOME"

    $CHAIN_BINARY genesis collect-gentxs --home "$CHAIN_HOME"

    echo "--- Validating genesis file ---"
    $CHAIN_BINARY genesis validate --home "$CHAIN_HOME"

    CONFIG_TOML="$CHAIN_HOME/config/config.toml"
    APP_TOML="$CHAIN_HOME/config/app.toml"
    
    # --- config.toml の設定変更 (上限を150MBに引き上げ) ---
    sed -i 's/laddr = "tcp:\/\/127.0.0.1:26657"/laddr = "tcp:\/\/0.0.0.0:26657"/' "$CONFIG_TOML"
    sed -i 's/cors_allowed_origins = \[\]/cors_allowed_origins = \["\*"\]/' "$CONFIG_TOML"
    sed -i 's/^max_body_bytes = .*/max_body_bytes = 10737418240/' "$CONFIG_TOML" # 150MB
    sed -i 's/^max_tx_bytes = .*/max_tx_bytes = 10737418240/' "$CONFIG_TOML"   # 150MB
    
    # --- app.toml の設定変更 ---
    # sed -i 's/^minimum-gas-prices = ".*"/minimum-gas-prices = "0.000000001uatom"/' "$APP_TOML"

    # API, gRPCの有効化と設定 (上限を150MBに引き上げ)
    sed -i '/\[api\]/,/\[/{s/enable = false/enable = true/}' "$APP_TOML"
    sed -i '/\[api\]/,/\[/{s/address = "tcp:\/\/localhost:1317"/address = "tcp:\/\/0.0.0.0:1317"/}' "$APP_TOML"
    sed -i '/\[api\]/a max-request-body-size = 10737418240' "$APP_TOML" # 150MB
    sed -i '/\[grpc\]/,/\[/{s/enable = false/enable = true/}' "$APP_TOML"
    
    sed -i 's/^max-recv-msg-size = .*/max-recv-msg-size = "10737418240"/' "$APP_TOML"
    sed -i 's/^max-send-msg-size = .*/max-send-msg-size = "10737418240"/' "$APP_TOML"@
    
    sed -i '/\[grpc-web\]/,/\[/{s/enable = false/enable = true/}' "$APP_TOML"

    echo "--- Initialization complete for $CHAIN_ID ---"
fi

# --- ノードの起動 ---
echo "--- Starting node for $CHAIN_ID ---"
# minimum-gas-pricesを0に設定してノードを起動
exec $CHAIN_BINARY start --home "$CHAIN_HOME" --minimum-gas-prices="0$DENOM" --log_level error --log_format json