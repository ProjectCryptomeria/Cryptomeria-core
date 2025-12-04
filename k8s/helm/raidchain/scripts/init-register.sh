#!/bin/bash
set -e

# --- 環境変数と設定 ---
GWC_ID=${GWC_ID:-"gwc"}
CHAIN_NAMES_CSV=${CHAIN_NAMES_CSV}
RPC_NODE=${RPC_NODE}
KEY_NAME="relayer" # GWCノードのキー名
MNEMONIC_FILE="/etc/mnemonics/${GWC_ID}.mnemonic" # 秘密ファイルは/etc/mnemonicsにマウントされる想定
POD_NAMESPACE=$(cat /var/run/secrets/kubernetes.io/serviceaccount/namespace)
RELEASE_NAME=${RELEASE_NAME:-raidchain}

echo "--- Starting Robust Storage Registration Job ---"

# 1. 準備とキーのインポート
echo "Waiting for GWC RPC at $RPC_NODE..."
ATTEMPTS=0; MAX_ATTEMPTS=60
until curl -s "$RPC_NODE/status" > /dev/null || [ $ATTEMPTS -ge $MAX_ATTEMPTS ]; do 
    sleep 1; ATTEMPTS=$((ATTEMPTS + 1)); 
done
if [ $ATTEMPTS -ge $MAX_ATTEMPTS ]; then echo "❌ GWC RPC timeout."; exit 1; fi

echo "Importing key for transaction..."
# ジョブコンテナ（GWCイメージ）には鍵がないため、リレイヤーのニーモニックからインポート
if ! gwcd keys show $KEY_NAME --keyring-backend test >/dev/null 2>&1; then
    cat "$MNEMONIC_FILE" | gwcd keys add $KEY_NAME --recover --keyring-backend test
fi

# 期待される接続先IDのリストを取得 (GWC自身を除く)
EXPECTED_CHAIN_IDS=$(echo "$CHAIN_NAMES_CSV" | tr ',' ' ' | grep -v "$GWC_ID")
EXPECTED_TOTAL=$(echo "$EXPECTED_CHAIN_IDS" | wc -w)
echo "Expected chains to register: $EXPECTED_CHAIN_IDS ($EXPECTED_TOTAL total)"


# 2. チャネル情報の自動探索と登録処理 (リトライロジック内包)
register_endpoints() {
    local CURRENT_ATTEMPTS=$1
    REGISTRATION_ARGS=""
    FOUND_COUNT=0
    
    # GWCが持つ全てのチャネルを探索 (0から20まで、十分な範囲)
    for i in $(seq 0 20); do
        CHANNEL_ID="channel-$i"
        
        # ClientStateを取得 (ClientState内に相手のChainIDがある)
        CLIENT_STATE_JSON=$(gwcd query ibc channel client-state gateway $CHANNEL_ID --node $RPC_NODE --output json 2>/dev/null || true)
        
        if [ -n "$CLIENT_STATE_JSON" ]; then
            # ChainIDを抽出。ClientState内にあるため最も確実。
            TARGET_CHAIN_ID=$(echo "$CLIENT_STATE_JSON" | jq -r '.client_state.chain_id // .chain_id // empty')
            
            if [ -n "$TARGET_CHAIN_ID" ]; then
                # 期待されるチェーンIDかどうか確認
                if [[ " $EXPECTED_CHAIN_IDS " =~ " $TARGET_CHAIN_ID " ]]; then
                    # K8s Service名とAPIエンドポイントを構築
                    # TARGET_CHAIN_IDは fdsc-0 や mdsc であることを想定
                    TARGET_ENDPOINT="http://${RELEASE_NAME}-${TARGET_CHAIN_ID}-headless.${POD_NAMESPACE}.svc.cluster.local:1317"
                    
                    echo "  [OK] Found: $CHANNEL_ID -> $TARGET_CHAIN_ID ($TARGET_ENDPOINT)"
                    
                    # [channel-id] [chain-id] [url] の形式で追加
                    REGISTRATION_ARGS="$REGISTRATION_ARGS $CHANNEL_ID $TARGET_CHAIN_ID $TARGET_ENDPOINT"
                    FOUND_COUNT=$((FOUND_COUNT + 1))
                fi
            fi
        fi
    done

    # 必要なチャネル数が発見されたかチェック
    if [ "$FOUND_COUNT" -ne "$EXPECTED_TOTAL" ]; then
        echo "⚠️ Found only $FOUND_COUNT/$EXPECTED_TOTAL channels. Retrying in 1s..."
        return 1 # 再試行のために失敗を返す
    fi
    
    # 3. トランザクション送信
    echo "--- Submitting Register Transaction (Attempt $CURRENT_ATTEMPTS) ---"

    TX_CMD="gwcd tx gateway register-storage $REGISTRATION_ARGS --from $KEY_NAME --chain-id $GWC_ID --node $RPC_NODE --keyring-backend test -y --output json"

    # 実行
    TX_RESULT=$($TX_CMD 2>&1)
    
    # 成功判定 (code: 0 が含まれているか)
    if echo "$TX_RESULT" | grep -q '"code":0'; then
        echo "🎉 Storage Endpoints successfully registered!"
        return 0
    else
        echo "❌ Transaction failed."
        echo "--- TX Output ---"
        echo "$TX_RESULT"
        echo "-----------------"
        return 1
    fi
}

# 4. 実行とリトライ
MAX_ATTEMPTS=60 # 60回リトライ (1分待機)
ATTEMPTS=0
until register_endpoints $ATTEMPTS; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ $ATTEMPTS -ge $MAX_ATTEMPTS ]; then
        echo "❌ Timed out waiting for all IBC channels to be ready and registered."
        exit 1
    fi
    sleep 1
done

echo "✅ Registration Job Complete."