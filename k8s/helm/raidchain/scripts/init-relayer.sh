#!/bin/sh
set -e

# --- 環境変数と設定 ---
CHAIN_NAMES_CSV=${CHAIN_NAMES_CSV}
HEADLESS_SERVICE_NAME=${HEADLESS_SERVICE_NAME}
POD_NAMESPACE=$(cat /var/run/secrets/kubernetes.io/serviceaccount/namespace)
RELEASE_NAME=${RELEASE_NAME:-raidchain}

RELAYER_HOME="/home/relayer/.relayer"
KEY_NAME="relayer"
DENOM="uatom"
PATH_PREFIX="path"
MNEMONICS_DIR="/etc/relayer/mnemonics"

if [ -z "$CHAIN_NAMES_CSV" ] || [ -z "$HEADLESS_SERVICE_NAME" ]; then
  echo "Error: CHAIN_NAMES_CSV and HEADLESS_SERVICE_NAME must be set."
  exit 1
fi

CHAIN_IDS=$(echo "$CHAIN_NAMES_CSV" | tr ',' ' ')

# --- リレイヤーの初期化（初回起動時のみ） ---
if [ ! -f "$RELAYER_HOME/config/config.yaml" ]; then
    echo "--- Initializing relayer configuration ---"
    rly config init

    TMP_DIR="/tmp/relayer-configs"
    mkdir -p "$TMP_DIR"
    trap 'rm -rf -- "$TMP_DIR"' EXIT

    # --- チェーン設定の追加 ---
    echo "--- Adding chain configurations ---"
    for CHAIN_ID in $CHAIN_IDS; do
        POD_HOSTNAME="${RELEASE_NAME}-${CHAIN_ID}-0"
        RPC_ADDR="http://${POD_HOSTNAME}.${HEADLESS_SERVICE_NAME}.${POD_NAMESPACE}.svc.cluster.local:26657"
        GRPC_ADDR="${POD_HOSTNAME}.${HEADLESS_SERVICE_NAME}.${POD_NAMESPACE}.svc.cluster.local:9090"
        TMP_JSON_FILE="${TMP_DIR}/${CHAIN_ID}.json"
        cat > "$TMP_JSON_FILE" <<EOF
{
  "type": "cosmos",
  "value": {
    "key": "$KEY_NAME", "chain-id": "$CHAIN_ID", "rpc-addr": "$RPC_ADDR", "grpc-addr": "$GRPC_ADDR",
    "account-prefix": "cosmos", "keyring-backend": "test", "gas-adjustment": 1.5,
    "gas-prices": "0.001$DENOM", "debug": false, "timeout": "20s", "output-format": "json", "sign-mode": "direct"
  }
}
EOF
        rly chains add --file "$TMP_JSON_FILE"
    done

    # --- キーのリストア ---
    echo "--- Restoring relayer keys ---"
    for CHAIN_ID in $CHAIN_IDS; do
        MNEMONIC_FILE="${MNEMONICS_DIR}/${CHAIN_ID}.mnemonic"
        echo "--> Waiting for mnemonic for ${CHAIN_ID}..."
        while [ ! -f "$MNEMONIC_FILE" ]; do sleep 1; done
        RELAYER_MNEMONIC=$(cat "$MNEMONIC_FILE")
        rly keys restore "$CHAIN_ID" "$KEY_NAME" "$RELAYER_MNEMONIC"
    done

    # --- IBCパスの定義 ---
    echo "--- Defining IBC paths ---"
    META_CHAIN_ID=""
    DATA_CHAIN_IDS=""
    for CHAIN_ID in $CHAIN_IDS; do
      if [[ $CHAIN_ID == meta-* ]]; then META_CHAIN_ID=$CHAIN_ID; else DATA_CHAIN_IDS="$DATA_CHAIN_IDS $CHAIN_ID"; fi
    done
    if [ -z "$META_CHAIN_ID" ]; then echo "Error: No 'meta' chain found."; exit 1; fi

    for DATA_CHAIN_ID in $DATA_CHAIN_IDS; do
        PATH_NAME="${PATH_PREFIX}-${DATA_CHAIN_ID}-to-${META_CHAIN_ID}"
        echo "--> Defining IBC path: $PATH_NAME with version ${RELEASE_NAME}-1"
        rly paths new "$DATA_CHAIN_ID" "$META_CHAIN_ID" "$PATH_NAME"
    done

    # --- 全チェーンの準備待機 ---
    echo "--- Waiting for all chains to be ready... ---"
    for CHAIN_ID in $CHAIN_IDS; do
        RPC_ADDR="http://${RELEASE_NAME}-${CHAIN_ID}-0.${HEADLESS_SERVICE_NAME}.${POD_NAMESPACE}.svc.cluster.local:26657"
        echo "--> RPC Address : $RPC_ADDR"
        echo "--> Waiting for chain '$CHAIN_ID' to reach height 5..."
        ATTEMPTS=0; MAX_ATTEMPTS=30
        until [ $ATTEMPTS -ge $MAX_ATTEMPTS ]; do
            HEIGHT=$(curl -s "${RPC_ADDR}/status" | jq -r '.result.sync_info.latest_block_height // "0"')
            if [ -n "$HEIGHT" ] && [ "$HEIGHT" -ge 5 ]; then echo "     Chain '$CHAIN_ID' is ready at height $HEIGHT."; break; fi
            ATTEMPTS=$((ATTEMPTS + 1)); echo "     Current height of '$CHAIN_ID' is $HEIGHT. Waiting... (Attempt $ATTEMPTS/$MAX_ATTEMPTS)"; sleep 5
        done
        if [ $ATTEMPTS -ge $MAX_ATTEMPTS ]; then echo "!!! Timed out waiting for chain '$CHAIN_ID' to start. !!!"; exit 1; fi
    done

    # クライアント、接続、チャネルを順番に手動で確立
    echo "--- Manually creating Clients, Connections, and Channels for all paths ---"
    for DATA_CHAIN_ID in $DATA_CHAIN_IDS; do
        # パス名の組み立て方を、`rly paths new`で定義した時と同じ順序に修正
        PATH_NAME="${PATH_PREFIX}-${DATA_CHAIN_ID}-to-${META_CHAIN_ID}"

        echo "--> Full link setup for path: $PATH_NAME"
        
        # 1. クライアント作成 (--overrideで常に新規作成)
        echo "     Step 1: Creating clients..."
        rly transact clients "$PATH_NAME" --override --log-level warn
        sleep 5

        # 2. 接続確立
        echo "     Step 2: Creating connection..."
        rly transact connection "$PATH_NAME" -t 30s -r 5 --log-level warn
        sleep 5

        # 3. チャネル開設
        echo "     Step 3: Creating channel..."
        rly transact channel "$PATH_NAME" --src-port datastore --dst-port metastore --order unordered --version "raidchain-1" -t 30s -r 5 --log-level warn
        
        echo "✅ Path $PATH_NAME fully linked."
    done

    echo "--- Initialization complete ---"
fi

# --- Relayerを起動し、確立されたチャネルでパケットをリッスンする ---
echo "--- Starting relayer to listen for packets on established channels... ---"
exec rly start --log-level warn --log-format json