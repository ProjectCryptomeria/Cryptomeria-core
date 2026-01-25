{{- define "cryptomeria.scripts.genesis" -}}
#!/bin/sh
set -e
set -x

OUTPUT_DIR="/shared"
MNEMONIC_DIR="/etc/mnemonics"

# --- Helper Function ---
generate_genesis() {
    local CHAIN_ID=$1
    local BINARY=$2
    local KEY_FILE=$3
    local HOME_DIR="/tmp/genesis_home/$CHAIN_ID"

    if ! command -v $BINARY ; then
        echo "⚠️  Skipping generation for $CHAIN_ID: Binary '$BINARY' not found in this container."
        return 0
    fi

    echo "--> Generating Genesis for $CHAIN_ID using $BINARY..."
    
    if [ ! -f "$KEY_FILE" ]; then
        echo "❌ Error: Key file not found: $KEY_FILE"
        exit 1
    fi

    rm -rf $HOME_DIR
    mkdir -p $HOME_DIR

    # 1. Init
    $BINARY init $CHAIN_ID --chain-id $CHAIN_ID --home $HOME_DIR

    # 2. Add Key (Local Admin)
    $BINARY keys add local-admin --recover --keyring-backend=test --home $HOME_DIR < $KEY_FILE
    local ADDR=$($BINARY keys show local-admin -a --keyring-backend=test --home $HOME_DIR)

    # 3. Add Genesis Account (Local Admin)
    $BINARY genesis add-genesis-account $ADDR 1000000000000uatom --home $HOME_DIR

    # Relayerアカウントの追加
    local RELAYER_KEY_FILE=$(echo "$KEY_FILE" | sed 's/local-admin/relayer/')
    if [ -f "$RELAYER_KEY_FILE" ]; then
        echo "   -> Adding Relayer account from $RELAYER_KEY_FILE"
        $BINARY keys add relayer --recover --keyring-backend=test --home $HOME_DIR < $RELAYER_KEY_FILE
        local RELAYER_ADDR=$($BINARY keys show relayer -a --keyring-backend=test --home $HOME_DIR)
        $BINARY genesis add-genesis-account $RELAYER_ADDR 1000000000uatom --home $HOME_DIR
    else
        echo "⚠️ Relayer key file not found: $RELAYER_KEY_FILE"
    fi

    # ▼▼▼ 修正: Gentxの前にパラメータ設定を行うように移動 ▼▼▼
    # これにより、collect-gentxs が出力した結果を上書きしてしまう事故を防ぐ
    if [ "$CHAIN_ID" = "gwc" ]; then
        echo "🔧 Configuring gwc gateway.params.local_admin via custom command..."
        $BINARY genesis set-local-admin "$ADDR" --home "$HOME_DIR"
    fi
    # ▲▲▲ 移動ここまで ▲▲▲

    # 4. Gentx
    $BINARY genesis gentx local-admin 10000000uatom --keyring-backend=test --chain-id $CHAIN_ID --home $HOME_DIR

    # 5. Collect Gentxs
    # これが最後に実行され、gen_txsを含む最終的なgenesis.jsonが作られる
    $BINARY genesis collect-gentxs --home $HOME_DIR

    # 6. Export
    cp $HOME_DIR/config/genesis.json $OUTPUT_DIR/$CHAIN_ID.json
    
    # バリデータ鍵もエクスポートする
    cp $HOME_DIR/config/priv_validator_key.json $OUTPUT_DIR/$CHAIN_ID-priv_validator_key.json
    
    # Nginxが読めるようにパーミッションを変更 (Read for All)
    chmod 644 $OUTPUT_DIR/$CHAIN_ID.json
    
    # 鍵ファイルの権限変更
    chmod 644 $OUTPUT_DIR/$CHAIN_ID-priv_validator_key.json
    
    echo "✅ Created $OUTPUT_DIR/$CHAIN_ID.json"
}

# --- Main ---
# GWC
generate_genesis "gwc" "gwcd" "$MNEMONIC_DIR/gwc.local-admin.mnemonic"

# MDSC
generate_genesis "mdsc" "mdscd" "$MNEMONIC_DIR/mdsc.local-admin.mnemonic"

# FDSC
REPLICAS=${FDSC_REPLICAS:-1}
i=0
while [ $i -lt $REPLICAS ]; do
    generate_genesis "fdsc-$i" "fdscd" "$MNEMONIC_DIR/fdsc-$i.local-admin.mnemonic"
    i=$((i + 1))
done
{{- end -}}