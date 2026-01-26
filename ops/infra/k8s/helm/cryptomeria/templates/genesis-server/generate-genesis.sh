# projectcryptomeria/cryptomeria-core/Cryptomeria-core-4-dev/ops/infra/k8s/helm/cryptomeria/templates/genesis-server/generate-genesis.sh

{{- define "cryptomeria.scripts.genesis" -}}
#!/bin/sh
set -e
set -x

OUTPUT_DIR="/shared"
MNEMONIC_DIR="/etc/mnemonics"

generate_genesis() {
    local CHAIN_ID=$1
    local BINARY=$2
    local KEY_FILE=$3
    local HOME_DIR="/tmp/genesis_home/$CHAIN_ID"

    if ! command -v $BINARY ; then
        echo "⚠️  Skipping generation for $CHAIN_ID: Binary '$BINARY' not found."
        return 0
    fi

    rm -rf $HOME_DIR
    mkdir -p $HOME_DIR

    # 1. Init
    $BINARY init $CHAIN_ID --chain-id $CHAIN_ID --home $HOME_DIR

    # --- 修正箇所：デフォルト Denom を uatom に統一 ---
    sed -i 's/"stake"/"uatom"/g' $HOME_DIR/config/genesis.json

    # 2. Add Key (Local Admin)
    $BINARY keys add local-admin --recover --keyring-backend=test --home $HOME_DIR < $KEY_FILE
    local ADDR=$($BINARY keys show local-admin -a --keyring-backend=test --home $HOME_DIR)

    # 3. Add Genesis Account
    $BINARY genesis add-genesis-account $ADDR 1000000000000uatom --home $HOME_DIR

    # Relayer
    local RELAYER_KEY_FILE=$(echo "$KEY_FILE" | sed 's/local-admin/relayer/')
    if [ -f "$RELAYER_KEY_FILE" ]; then
        $BINARY keys add relayer --recover --keyring-backend=test --home $HOME_DIR < $RELAYER_KEY_FILE
        local RELAYER_ADDR=$($BINARY keys show relayer -a --keyring-backend=test --home $HOME_DIR)
        $BINARY genesis add-genesis-account $RELAYER_ADDR 1000000000uatom --home $HOME_DIR
    fi

    # 4. Gentx
    $BINARY genesis gentx local-admin 10000000uatom --keyring-backend=test --chain-id $CHAIN_ID --home $HOME_DIR

    # 5. Collect Gentxs (AppState の最終化)
    $BINARY genesis collect-gentxs --home $HOME_DIR

    # --- 修正箇所：コマンド名を set-admin に、タイミングを最終化の後に移動 ---
    if [ "$CHAIN_ID" = "gwc" ]; then
        echo "🔧 Finalizing gwc gateway parameters..."
        $BINARY genesis set-admin "$ADDR" --home "$HOME_DIR"
    fi

    # 6. Export
    cp $HOME_DIR/config/genesis.json $OUTPUT_DIR/$CHAIN_ID.json
    cp $HOME_DIR/config/priv_validator_key.json $OUTPUT_DIR/$CHAIN_ID-priv_validator_key.json
    chmod 644 $OUTPUT_DIR/$CHAIN_ID.json
    chmod 644 $OUTPUT_DIR/$CHAIN_ID-priv_validator_key.json
}

# Main
generate_genesis "gwc" "gwcd" "$MNEMONIC_DIR/gwc.local-admin.mnemonic"
generate_genesis "mdsc" "mdscd" "$MNEMONIC_DIR/mdsc.local-admin.mnemonic"

REPLICAS=${FDSC_REPLICAS:-1}
i=0
while [ $i -lt $REPLICAS ]; do
    generate_genesis "fdsc-$i" "fdscd" "$MNEMONIC_DIR/fdsc-$i.local-admin.mnemonic"
    i=$((i + 1))
done
{{- end -}}