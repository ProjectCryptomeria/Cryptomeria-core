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

    # --- 1. チェーン設定の追加 ---
    echo "--- Adding chain configurations ---"
    for CHAIN_ID in $CHAIN_IDS; do
        POD_HOSTNAME="${RELEASE_NAME}-${CHAIN_ID}-0"
        RPC_ADDR="http://${POD_HOSTNAME}.${HEADLESS_SERVICE_NAME}.${POD_NAMESPACE}.svc.cluster.local:26657"
        GRPC_ADDR="${POD_HOSTNAME}.${HEADLESS_SERVICE_NAME}.${POD_NAMESPACE}.svc.cluster.local:9090"
        TMP_JSON_FILE="${TMP_DIR}/${CHAIN_ID}.json"
        
        # ガス価格などの設定
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

    # --- 2. キーのリストア ---
    echo "--- Restoring relayer keys ---"
    for CHAIN_ID in $CHAIN_IDS; do
        MNEMONIC_FILE="${MNEMONICS_DIR}/${CHAIN_ID}.mnemonic"
        echo "--> Waiting for mnemonic for ${CHAIN_ID}..."
        while [ ! -f "$MNEMONIC_FILE" ]; do sleep 1; done
        RELAYER_MNEMONIC=$(cat "$MNEMONIC_FILE")
        rly keys restore "$CHAIN_ID" "$KEY_NAME" "$RELAYER_MNEMONIC"
    done

    # --- 3. チェーンIDの分類 (GWC, MDSC, FDSC) ---
    GWC_ID=""
    MDSC_ID=""
    FDSC_IDS=""

    for CHAIN_ID in $CHAIN_IDS; do
      if [[ $CHAIN_ID == *gwc* ]]; then
        GWC_ID=$CHAIN_ID
      elif [[ $CHAIN_ID == *mdsc* ]]; then
        MDSC_ID=$CHAIN_ID
      elif [[ $CHAIN_ID == *fdsc* ]]; then
        FDSC_IDS="$FDSC_IDS $CHAIN_ID"
      fi
    done

    if [ -z "$GWC_ID" ]; then echo "Error: No 'gwc' chain found."; exit 1; fi
    # MDSCやFDSCが見つからない場合の警告（必須ではないが構成上必要）
    if [ -z "$MDSC_ID" ]; then echo "Warning: No 'mdsc' chain found."; fi
    if [ -z "$FDSC_IDS" ]; then echo "Warning: No 'fdsc' chains found."; fi

    # --- 4. IBCパスの定義 ---
    echo "--- Defining IBC paths ---"

    # Path: GWC <-> FDSC (Gateway to Datastore)
    for FDSC_ID in $FDSC_IDS; do
        PATH_NAME="${PATH_PREFIX}-${GWC_ID}-to-${FDSC_ID}"
        echo "--> Defining path: $PATH_NAME"
        rly paths new "$GWC_ID" "$FDSC_ID" "$PATH_NAME"
    done

    # Path: GWC <-> MDSC (Gateway to Metastore)
    if [ -n "$MDSC_ID" ]; then
        PATH_NAME="${PATH_PREFIX}-${GWC_ID}-to-${MDSC_ID}"
        echo "--> Defining path: $PATH_NAME"
        rly paths new "$GWC_ID" "$MDSC_ID" "$PATH_NAME"
    fi

    # --- 5. 全チェーンの準備待機 ---
    echo "--- Waiting for all chains to be ready... ---"
    for CHAIN_ID in $CHAIN_IDS; do
        RPC_ADDR="http://${RELEASE_NAME}-${CHAIN_ID}-0.${HEADLESS_SERVICE_NAME}.${POD_NAMESPACE}.svc.cluster.local:26657"
        echo "--> Checking $CHAIN_ID at $RPC_ADDR"
        ATTEMPTS=0; MAX_ATTEMPTS=60
        until [ $ATTEMPTS -ge $MAX_ATTEMPTS ]; do
            HEIGHT=$(curl -s "${RPC_ADDR}/status" | jq -r '.result.sync_info.latest_block_height // "0"')
            if [ -n "$HEIGHT" ] && [ "$HEIGHT" -ge 1 ]; then echo "     Chain '$CHAIN_ID' is ready (Height: $HEIGHT)."; break; fi
            ATTEMPTS=$((ATTEMPTS + 1)); sleep 3
        done
        if [ $ATTEMPTS -ge $MAX_ATTEMPTS ]; then echo "!!! Timed out waiting for chain '$CHAIN_ID'. !!!"; exit 1; fi
    done

    # --- 6. クライアント・接続・チャネルの確立 ---
    echo "--- Establishing IBC connections ---"

    # Function to link path
    link_path() {
        P_NAME=$1
        SRC_PORT=$2
        DST_PORT=$3
        echo "--> Linking $P_NAME ($SRC_PORT <-> $DST_PORT)"
        
        # Clients & Connection
        rly transact clients "$P_NAME" --override
        sleep 2
        rly transact connection "$P_NAME"
        sleep 2
        
        # Channel
        # Note: version "raidchain-1" is arbitrary; ensure modules support it or use empty
        rly transact channel "$P_NAME" \
            --src-port "$SRC_PORT" \
            --dst-port "$DST_PORT" \
            --order unordered \
            --version "raidchain-1"
        
        echo "✅ Path $P_NAME linked."
    }

    # GWC -> FDSCs
    for FDSC_ID in $FDSC_IDS; do
        PATH_NAME="${PATH_PREFIX}-${GWC_ID}-to-${FDSC_ID}"
        # src: gwc(gateway), dst: fdsc(datastore)
        link_path "$PATH_NAME" "gateway" "datastore"
    done

    # GWC -> MDSC
    if [ -n "$MDSC_ID" ]; then
        PATH_NAME="${PATH_PREFIX}-${GWC_ID}-to-${MDSC_ID}"
        # src: gwc(gateway), dst: mdsc(metastore)
        link_path "$PATH_NAME" "gateway" "metastore"
    fi

    echo "--- Initialization complete ---"
fi

# --- Relayerの起動 ---
echo "--- Starting relayer ---"
exec rly start --log-level warn --log-format json