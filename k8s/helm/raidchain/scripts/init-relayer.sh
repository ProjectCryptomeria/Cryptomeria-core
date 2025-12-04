#!/bin/bash
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
    
    rm -rf "$RELAYER_HOME/paths"
    rly config init

    TMP_DIR="/tmp/relayer-configs"
    mkdir -p "$TMP_DIR"
    trap 'rm -rf -- "$TMP_DIR"' EXIT

    # --- 1. チェーン設定の追加 ---
    echo "--- Adding chain configurations ---"
    for CHAIN_ID in $CHAIN_IDS; do
        SERVICE_NAME="${RELEASE_NAME}-${CHAIN_ID}-headless"
        RPC_ADDR="http://${SERVICE_NAME}.${POD_NAMESPACE}.svc.cluster.local:26657"
        GRPC_ADDR="http://${SERVICE_NAME}.${POD_NAMESPACE}.svc.cluster.local:9090"
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

    # --- 2. チェーンIDの分類 ---
    GWC_ID=""
    MDSC_ID=""
    FDSC_IDS=""
    for CHAIN_ID in $CHAIN_IDS; do
      if [[ $CHAIN_ID == *gwc* ]]; then GWC_ID=$CHAIN_ID;
      elif [[ $CHAIN_ID == *mdsc* ]]; then MDSC_ID=$CHAIN_ID;
      elif [[ $CHAIN_ID == *fdsc* ]]; then FDSC_IDS="$FDSC_IDS $CHAIN_ID"; fi
    done

    if [ -z "$GWC_ID" ]; then echo "Error: No 'gwc' chain found."; exit 1; fi

    # --- 3. キーのリストア ---
    echo "--- Restoring relayer keys ---"
    for CHAIN_ID in $CHAIN_IDS; do
        MNEMONIC_FILE="${MNEMONICS_DIR}/${CHAIN_ID}.mnemonic"
        while [ ! -f "$MNEMONIC_FILE" ]; do sleep 1; done
        RELAYER_MNEMONIC=$(cat "$MNEMONIC_FILE")
        rly keys restore "$CHAIN_ID" "$KEY_NAME" "$RELAYER_MNEMONIC"
    done

    # --- 4. IBCパスの定義 ---
    echo "--- Defining IBC paths ---"
    for FDSC_ID in $FDSC_IDS; do
        PATH_NAME="${PATH_PREFIX}-${GWC_ID}-to-${FDSC_ID}"
        rly paths new "$GWC_ID" "$FDSC_ID" "$PATH_NAME"
    done
    if [ -n "$MDSC_ID" ]; then
        PATH_NAME="${PATH_PREFIX}-${GWC_ID}-to-${MDSC_ID}"
        rly paths new "$GWC_ID" "$MDSC_ID" "$PATH_NAME"
    fi

    # --- 5. 全チェーンの準備待機 ---
    echo "--- Waiting for all chains to be ready... ---"
    for CHAIN_ID in $CHAIN_IDS; do
        SERVICE_NAME="${RELEASE_NAME}-${CHAIN_ID}-headless"
        RPC_ADDR="http://${SERVICE_NAME}.${POD_NAMESPACE}.svc.cluster.local:26657"
        # 修正: パイプラインが失敗して空文字列になる場合に備え、|| echo "0" を追加
        until [ $(curl -s "${RPC_ADDR}/status" | jq -r '.result.sync_info.latest_block_height // "0"' || echo "0") -ge 5 ]; do
            sleep 1
        done
        echo "Chain $CHAIN_ID is ready."
    done

    # --- 6. クライアント・接続・チャネルの確立 (リトライロジック付き) ---
    echo "--- Establishing IBC connections ---"
    retry() {
        local n=1; local max=30; local delay=1
        while true; do
            "$@" && break
            if [[ $n -lt $max ]]; then ((n++)); echo "Retry $n/$max..."; sleep $delay; else return 1; fi
        done
    }
    link_path() {
        P_NAME=$1; SRC=$2; DST=$3
        echo "Linking $P_NAME..."
        retry rly transact clients "$P_NAME" --override || return 1
        retry rly transact connection "$P_NAME" || return 1
        retry rly transact channel "$P_NAME" --src-port "$SRC" --dst-port "$DST" --order unordered --version "raidchain-1" || return 1
        echo "✅ Path $P_NAME linked."
    }

    PIDS=""
    for FDSC_ID in $FDSC_IDS; do
        link_path "${PATH_PREFIX}-${GWC_ID}-to-${FDSC_ID}" "gateway" "datastore" &
        PIDS="$PIDS $!"
    done
    if [ -n "$MDSC_ID" ]; then
        link_path "${PATH_PREFIX}-${GWC_ID}-to-${MDSC_ID}" "gateway" "metastore" &
        PIDS="$PIDS $!"
    fi

    for PID in $PIDS; do wait $PID; done
    echo "--- IBC Initialization complete ---"
fi

# --- Relayerの起動 ---
echo "--- Starting relayer ---"
exec rly start --log-level warn --log-format json