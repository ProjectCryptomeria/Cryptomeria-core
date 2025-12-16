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
    
    if ! command -v $BINARY >/dev/null 2>&1; then
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
    $BINARY init $CHAIN_ID --chain-id $CHAIN_ID --home $HOME_DIR >/dev/null 2>&1

    # 2. Add Key
    $BINARY keys add local-admin --recover --keyring-backend=test --home $HOME_DIR < $KEY_FILE >/dev/null 2>&1
    local ADDR=$($BINARY keys show local-admin -a --keyring-backend=test --home $HOME_DIR)

    # 3. Add Genesis Account
    $BINARY genesis add-genesis-account $ADDR 1000000000000uatom --home $HOME_DIR

    # 4. Gentx
    $BINARY genesis gentx local-admin 10000000uatom --keyring-backend=test --chain-id $CHAIN_ID --home $HOME_DIR >/dev/null 2>&1

    # 5. Collect Gentxs
    $BINARY genesis collect-gentxs --home $HOME_DIR >/dev/null 2>&1

    # 6. Export
    cp $HOME_DIR/config/genesis.json $OUTPUT_DIR/$CHAIN_ID.json
    
    # ▼▼▼ 追加: Nginxが読めるようにパーミッションを変更 (Read for All) ▼▼▼
    chmod 644 $OUTPUT_DIR/$CHAIN_ID.json
    # ▲▲▲ 追加ここまで ▲▲▲
    
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