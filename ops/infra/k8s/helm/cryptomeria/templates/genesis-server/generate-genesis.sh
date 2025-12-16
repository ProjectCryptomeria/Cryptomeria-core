{{- define "cryptomeria.scripts.genesis" -}}
#!/bin/sh
set -e
OUTPUT_DIR="/shared"
MNEMONIC_DIR="/etc/mnemonics"

# --- Helper Function ---
generate_genesis() {
    local CHAIN_ID=$1
    local BINARY=$2
    local KEY_FILE=$3
    local HOME_DIR="/tmp/genesis_home/$CHAIN_ID"
    
    echo "--> Generating Genesis for $CHAIN_ID using $BINARY..."
    rm -rf $HOME_DIR
    mkdir -p $HOME_DIR

    # 1. Init
    $BINARY init $CHAIN_ID --chain-id $CHAIN_ID --home $HOME_DIR >/dev/null 2>&1

    # 2. Add Key (Recover from mnemonic)
    cat $KEY_FILE | $BINARY keys add local-admin --recover --keyring-backend=test --home $HOME_DIR >/dev/null 2>&1
    local ADDR=$($BINARY keys show local-admin -a --keyring-backend=test --home $HOME_DIR)

    # 3. Add Genesis Account
    $BINARY genesis add-genesis-account $ADDR 1000000000000uatom --home $HOME_DIR

    # 4. Gentx (Create Validator)
    $BINARY genesis gentx local-admin 10000000uatom --keyring-backend=test --chain-id $CHAIN_ID --home $HOME_DIR >/dev/null 2>&1

    # 5. Collect Gentxs
    $BINARY genesis collect-gentxs --home $HOME_DIR >/dev/null 2>&1

    # 6. Export
    cp $HOME_DIR/config/genesis.json $OUTPUT_DIR/$CHAIN_ID.json
    echo "✅ Created $OUTPUT_DIR/$CHAIN_ID.json"
}

# --- Main ---
# GWC
generate_genesis "gwc" "gwcd" "$MNEMONIC_DIR/gwc.local-admin.mnemonic"

# MDSC
generate_genesis "mdsc" "mdscd" "$MNEMONIC_DIR/mdsc.local-admin.mnemonic"

# FDSC (Loop)
REPLICAS=${FDSC_REPLICAS:-1}
i=0
while [ $i -lt $REPLICAS ]; do
    generate_genesis "fdsc-$i" "fdscd" "$MNEMONIC_DIR/fdsc.local-admin.mnemonic"
    i=$((i + 1))
done
{{- end -}}