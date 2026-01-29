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

    # jq が無いと困るので明示チェック（必要なら消してOK）
    if ! command -v jq >/dev/null 2>&1 ; then
        echo "❌ jq not found. Please install jq in this image."
        exit 1
    fi

    # 1. Init
    $BINARY init $CHAIN_ID --chain-id $CHAIN_ID --home $HOME_DIR

    GENESIS="$HOME_DIR/config/genesis.json"

    # --- Denom を uatom に統一（jqで安全に全置換） ---
    # 文字列 "stake" を含む値をすべて "uatom" に置換（元の sed と同等の広さ）
    tmp="$(mktemp)"
    jq 'walk(if type=="string" and .=="stake" then "uatom" else . end)' "$GENESIS" > "$tmp" && mv "$tmp" "$GENESIS"

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

    # -------------------------------------------------------------------------
    # ▼▼▼ ブロックサイズを最大 100MiB (= 104857600 bytes) に設定（jq） ▼▼▼
    # Cosmos SDK の genesis では max_bytes が "文字列" で入っていることが多いので tostring で合わせる
    # -------------------------------------------------------------------------
    MAX_BLOCK_BYTES=104857600
    tmp="$(mktemp)"
    jq --arg mb "$MAX_BLOCK_BYTES" '
      .consensus.params.block.max_bytes = ($mb|tostring)
    ' "$GENESIS" > "$tmp" && mv "$tmp" "$GENESIS"
    # ▲▲▲ 追加ここまで ▲▲▲

    # --- gwc の追加設定 ---
    if [ "$CHAIN_ID" = "gwc" ]; then
        echo "🔧 Finalizing gwc gateway parameters..."
        $BINARY genesis set-admin "$ADDR" --home "$HOME_DIR"
        # set-admin が genesis を書き換える可能性があるので、確実にしたいならここでもう一度 jq を当てる:
        tmp="$(mktemp)"
        jq --arg mb "$MAX_BLOCK_BYTES" '
          .consensus.params.block.max_bytes = ($mb|tostring)
        ' "$GENESIS" > "$tmp" && mv "$tmp" "$GENESIS"
    fi

    # 6. Export
    cp $GENESIS $OUTPUT_DIR/$CHAIN_ID.json
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
