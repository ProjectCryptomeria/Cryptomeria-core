#!/bin/bash
set -e

# --- 環境変数と設定 ---
CHAIN_NAMES_CSV=${CHAIN_NAMES_CSV}
HEADLESS_SERVICE_NAME=${HEADLESS_SERVICE_NAME}
POD_NAMESPACE=$(cat /var/run/secrets/kubernetes.io/serviceaccount/namespace)
RELEASE_NAME=${RELEASE_NAME:-cryptomeria}

RELAYER_HOME="/home/relayer/.relayer"
GWCD_HOME="/home/relayer/.gwc-client" # gwcd用のConfigディレクトリを分ける
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
    if [ -z "$MDSC_ID" ]; then echo "Warning: No 'mdsc' chain found."; fi
    if [ -z "$FDSC_IDS" ]; then echo "Warning: No 'fdsc' chains found."; fi

    # --- 2. キーのリストア ---
    echo "--- Restoring relayer keys ---"
    for CHAIN_ID in $CHAIN_IDS; do
        MNEMONIC_FILE="${MNEMONICS_DIR}/${CHAIN_ID}.mnemonic"
        echo "--> Waiting for mnemonic for ${CHAIN_ID}..."
        while [ ! -f "$MNEMONIC_FILE" ]; do sleep 1; done
        RELAYER_MNEMONIC=$(cat "$MNEMONIC_FILE")
        
        # rlyにキーをリストア
        rly keys restore "$CHAIN_ID" "$KEY_NAME" "$RELAYER_MNEMONIC"

        # 【追加】GWCの場合、gwcdコマンド実行用にローカルキーリングにもインポート
        if [ "$CHAIN_ID" == "$GWC_ID" ]; then
             echo "--> Importing relayer key to local gwcd keyring..."
             echo "$RELAYER_MNEMONIC" | gwcd keys add "$KEY_NAME" --recover --keyring-backend test --home "$GWCD_HOME"
        fi
    done

    # --- 4. IBCパスの定義 ---
    echo "--- Defining IBC paths ---"

    for FDSC_ID in $FDSC_IDS; do
        PATH_NAME="${PATH_PREFIX}-${GWC_ID}-to-${FDSC_ID}"
        echo "--> Defining path: $PATH_NAME"
        rly paths new "$GWC_ID" "$FDSC_ID" "$PATH_NAME"
    done

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
            #curlが失敗してもスクリプトを終了させず、空の結果として扱う
            STATUS_RES=$(curl -s --connect-timeout 2 "${RPC_ADDR}/status" || echo "")
            HEIGHT=$(echo "$STATUS_RES" | jq -r '.result.sync_info.latest_block_height // "0"')
            
            # 【修正】1 -> 5 に変更 (IBC Proof生成に必要な高さを確保)
            if [ -n "$HEIGHT" ] && [ "$HEIGHT" -ge 5 ]; then 
                echo "     Chain '$CHAIN_ID' is ready (Height: $HEIGHT)."
                break
            fi
            
            ATTEMPTS=$((ATTEMPTS + 1)); sleep 1 # チェック間隔を短くしても良い
        done
        if [ $ATTEMPTS -ge $MAX_ATTEMPTS ]; then echo "!!! Timed out waiting for chain '$CHAIN_ID'. !!!"; exit 1; fi
    done

# --- 6. クライアント・接続・チャネルの確立 (並列実行) ---
    echo "--- Establishing IBC connections (Parallel) ---"

    # 【追加】リトライ用関数
    # コマンドが失敗した場合、1秒待って再実行します（最大30回＝約30秒粘る）
    retry() {
        local n=1
        local max=30
        local delay=1
        while true; do
            # コマンド実行。成功したらループを抜ける
            "$@" && break 
            
            # 失敗時の処理
            if [[ $n -lt $max ]]; then
                ((n++))
                echo "⚠️ Command failed. Retrying in ${delay}s... ($n/$max)"
                sleep $delay;
            else
                echo "❌ The command has failed after $n attempts."
                return 1
            fi
        done
    }

    link_path() {
        P_NAME=$1
        SRC_PORT=$2
        DST_PORT=$3

        # --- 【追加】ランダム待機 (Jitter) ---
        SLEEP_TIME=$(( RANDOM % 15 ))
        echo "--> [Jitter] Sleeping ${SLEEP_TIME}s for $P_NAME..."
        sleep $SLEEP_TIME
        # ----------------------------------

        echo "--> [Start] Linking $P_NAME ($SRC_PORT <-> $DST_PORT)"
        
        # 【修正】個別のステップをやめ、linkコマンドを一括実行する
        # linkコマンドは成功時にconfigファイルを更新してくれるため、後続のID取得が成功します。
        retry rly transact link "$P_NAME" \
            --src-port "$SRC_PORT" \
            --dst-port "$DST_PORT" \
            --order unordered \
            --version "cryptomeria-1" || { echo "Failed to link path $P_NAME"; return 1; }
            
        echo "✅ [Done] Path $P_NAME linked."
    }

    PIDS=""
    for FDSC_ID in $FDSC_IDS; do
        PATH_NAME="${PATH_PREFIX}-${GWC_ID}-to-${FDSC_ID}"
        link_path "$PATH_NAME" "gateway" "datastore" &
        PIDS="$PIDS $!"
    done
    if [ -n "$MDSC_ID" ]; then
        PATH_NAME="${PATH_PREFIX}-${GWC_ID}-to-${MDSC_ID}"
        link_path "$PATH_NAME" "gateway" "metastore" &
        PIDS="$PIDS $!"
    fi

    echo "--- Waiting for parallel linking tasks to finish... ---"
    for PID in $PIDS; do
        wait $PID
        if [ $? -ne 0 ]; then
            echo "❌ Error: A linking process failed."
            exit 1
        fi
    done
    
    echo "--- IBC Initialization complete ---"

    # --- 7. ストレージエンドポイントの自動登録 ---
    echo "--- Auto-Registering Storage Endpoints via On-chain Tx ---"

    GWC_FULL_NAME="${RELEASE_NAME}-${GWC_ID}-0.${HEADLESS_SERVICE_NAME}.${POD_NAMESPACE}.svc.cluster.local"
    RPC_NODE="http://${GWC_FULL_NAME}:26657"
    API_PORT="1317"
    REGISTRATION_ARGS=""

    # 【追加】MDSCの登録引数作成 (チャネルIDを取得して追加)
    if [ -n "$MDSC_ID" ]; then
        MDSC_FULL_NAME="${RELEASE_NAME}-${MDSC_ID}-0.${HEADLESS_SERVICE_NAME}.${POD_NAMESPACE}.svc.cluster.local"
        MDSC_ENDPOINT="http://${MDSC_FULL_NAME}:${API_PORT}"
        
        # リレイヤーからチャネルIDを取得
        PATH_NAME="${PATH_PREFIX}-${GWC_ID}-to-${MDSC_ID}"
        CHANNEL_ID=$(rly paths show "$PATH_NAME" --json | jq -r '.chains.src.channel_id')
        
        if [ -z "$CHANNEL_ID" ] || [ "$CHANNEL_ID" == "null" ]; then
             echo "⚠️ Warning: Could not find channel ID for $PATH_NAME. Skipping registration."
        else
             # [channel-id] [chain-id] [url] の順に追加
             REGISTRATION_ARGS="$REGISTRATION_ARGS $CHANNEL_ID $MDSC_ID $MDSC_ENDPOINT"
        fi
    fi

    # 【追加】FDSCの登録引数作成 (チャネルIDを取得して追加)
    for FDSC_ID in $FDSC_IDS; do
        FDSC_FULL_NAME="${RELEASE_NAME}-${FDSC_ID}-0.${HEADLESS_SERVICE_NAME}.${POD_NAMESPACE}.svc.cluster.local"
        FDSC_ENDPOINT="http://${FDSC_FULL_NAME}:${API_PORT}"
        
        # リレイヤーからチャネルIDを取得
        PATH_NAME="${PATH_PREFIX}-${GWC_ID}-to-${FDSC_ID}"
        CHANNEL_ID=$(rly paths show "$PATH_NAME" --json | jq -r '.chains.src.channel_id')

        if [ -z "$CHANNEL_ID" ] || [ "$CHANNEL_ID" == "null" ]; then
             echo "⚠️ Warning: Could not find channel ID for $PATH_NAME. Skipping registration."
        else
             # [channel-id] [chain-id] [url] の順に追加
             REGISTRATION_ARGS="$REGISTRATION_ARGS $CHANNEL_ID $FDSC_ID $FDSC_ENDPOINT"
        fi
    done

    if [ -n "$REGISTRATION_ARGS" ]; then
        # コマンド実行 (変更なし)
        TX_COMMAND="gwcd tx gateway register-storage $REGISTRATION_ARGS --from $KEY_NAME --chain-id $GWC_ID --keyring-backend test --home $GWCD_HOME --node $RPC_NODE -y --output json"
        echo "--> Submitting: $TX_COMMAND"
        
        TX_RESULT=$($TX_COMMAND 2>&1)

        if echo "$TX_RESULT" | grep -q '"code":0'; then
            echo "✅ Storage Endpoints successfully registered."
        else
            echo "❌ Failed to register Storage Endpoints."
            echo "$TX_RESULT"
        fi
    fi
    
    # IBC初期化完了後、チェーンの安定化を待つための待機を追加
    echo "--- Waiting 5s for chain state stabilization after IBC setup ---"
    sleep 5 # 【修正】15秒から5秒に短縮（必要に応じて）
fi

exec rly chains list
exec rly paths list

# --- Relayerの起動 ---
echo "--- Starting relayer ---"
exec rly start --log-level warn --log-format json