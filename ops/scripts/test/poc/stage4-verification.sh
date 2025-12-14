#!/bin/bash
set -e

# --- 設定 ---
NAMESPACE="raidchain"
USER_NAME="relayer" 
CHAIN_ID_GWC="gwc"
PROJECT_NAME="stage4-test-site"
ZIP_FILENAME="${PROJECT_NAME}.zip"
TIMEOUT_SEC=120

# ユーティリティ関数
log() { echo -e "\033[1;34m[TEST]\033[0m $1"; }
error() { echo -e "\033[1;31m[ERROR]\033[0m $1"; }
success() { echo -e "\033[1;32m[PASS]\033[0m $1"; }

log "🚀 Starting Stage 4 Verification (On-chain Web)..."

# Pod名の取得
get_pod() {
    for i in {1..5}; do
        POD=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/instance=$1 -o jsonpath="{.items[0].metadata.name}" 2>/dev/null)
        if [ -n "$POD" ]; then
            echo "$POD"
            return 0
        fi
        sleep 1
    done
    echo ""
}

GWC_POD=$(get_pod gwc)
MDSC_POD=$(get_pod mdsc)
FDSC_POD=$(get_pod fdsc-0)

if [ -z "$GWC_POD" ] || [ -z "$MDSC_POD" ] || [ -z "$FDSC_POD" ]; then
    error "Failed to find pods. Is the chain deployed?"
    exit 1
fi

# --- 0.5 IBCチャネル待機 ---
wait_for_channels() {
    local target_pod=$1
    local expected_count=2 # FDSC + MDSC
    
    log "🔍 Checking IBC Channel Status on GWC..."
    log "⏳ Waiting for at least $expected_count OPEN channels on $target_pod..."
    
    for ((i=1; i<=TIMEOUT_SEC; i+=2)); do
        CHANNELS_JSON=$(kubectl exec -n "$NAMESPACE" "$target_pod" -- gwcd q ibc channel channels -o json 2>/dev/null || echo "{}")
        OPEN_CHANNELS=$(echo "$CHANNELS_JSON" | jq -r '.channels // [] | map(select(.state == "STATE_OPEN")) | length')
        
        if [ "$OPEN_CHANNELS" -ge "$expected_count" ]; then
            echo ""
            success "IBC Channels are ready! (Found: $OPEN_CHANNELS, Time: ${i}s)"
            return 0
        fi
        
        echo -ne "    ... checking channels ($OPEN_CHANNELS/$expected_count) (${i}/${TIMEOUT_SEC}s)\r"
        sleep 2
    done
    echo ""
    error "Timed out waiting for IBC channels. Is Relayer running?"
    return 1
}

wait_for_channels "$GWC_POD" || exit 1

# --- 1. テスト用Zipファイルの作成 ---
log "📦 Creating test zip file..."
TEMP_DIR=$(mktemp -d)
mkdir -p "$TEMP_DIR/$PROJECT_NAME"
echo "<html><body><h1>Hello On-chain Web!</h1></body></html>" > "$TEMP_DIR/$PROJECT_NAME/index.html"
echo "body { color: blue; }" > "$TEMP_DIR/$PROJECT_NAME/style.css"

# Zip作成 (ディレクトリ構造を維持)
current_dir=$(pwd)
# ディレクトリの中に入ってからZipする
cd "$TEMP_DIR/$PROJECT_NAME"
zip -r "../$ZIP_FILENAME" .
cd "$current_dir"

# GWC PodにZipをコピー
kubectl cp "$TEMP_DIR/$ZIP_FILENAME" "$NAMESPACE/$GWC_POD:/tmp/$ZIP_FILENAME"

log "✅ Zip file created and copied to GWC pod."

# --- 1.5 ストレージノードの登録 (K8s内部DNS) ---
log "🔗 Registering Storage Endpoints..."
# Note: Using headless services for internal communication
REGISTER_RES=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd tx gateway register-storage \
    mdsc "http://raidchain-mdsc-headless:1317" \
    channel-1 "http://raidchain-fdsc-0-headless:1317" \
    channel-2 "http://raidchain-fdsc-1-headless:1317" \
    --from $USER_NAME --chain-id $CHAIN_ID_GWC --keyring-backend test -y -o json)

REGISTER_CODE=$(echo "$REGISTER_RES" | jq -r '.code')
if [ "$REGISTER_CODE" != "0" ]; then
    error "Failed to register storage endpoints."
    echo "$REGISTER_RES" | jq -r '.raw_log'
    exit 1
fi
log "✅ Storage Endpoints Registered."
sleep 6 # Wait for block commit

# --- 2. アップロード実行 ---
log "Hz Sending Zip Upload Transaction..."
USER_ADDR=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd keys show $USER_NAME -a --keyring-backend test 2>/dev/null)

TX_RES=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd tx gateway upload "$ZIP_FILENAME" "@/tmp/$ZIP_FILENAME" \
    --from $USER_NAME --chain-id $CHAIN_ID_GWC --keyring-backend test -y -o json)

TX_CODE=$(echo "$TX_RES" | jq -r '.code')
TX_HASH=$(echo "$TX_RES" | jq -r '.txhash')

if [ "$TX_CODE" != "0" ]; then
    error "Transaction failed on submission. Raw log:"
    echo "$TX_RES" | jq -r '.raw_log'
    exit 1
fi

log "✅ Tx Sent! Hash: $TX_HASH"

# --- 3. 処理待ち ---
log "⏳ Waiting for processing (60s)..."
sleep 60

# --- 4. Webアクセス検証 ---
log "🌍 Verifying Web Access..."

# GWCのポート転送 (バックグラウンド)
kubectl port-forward -n "$NAMESPACE" "$GWC_POD" 1317:1317 > /dev/null 2>&1 &
PF_PID=$!
sleep 3

# クリーンアップ
trap "kill $PF_PID" EXIT

# HTMLの取得
URL="http://localhost:1317/render?project=$PROJECT_NAME&path=index.html"
log "   Fetching: $URL"
RESPONSE=$(curl -s "$URL")

if [[ "$RESPONSE" == *"Hello On-chain Web!"* ]]; then
    success "Content verified! Found 'Hello On-chain Web!'"
else
    error "Content verification failed."
    echo "Response: $RESPONSE"
    exit 1
fi

# CSSの取得
URL_CSS="http://localhost:1317/render?project=$PROJECT_NAME&path=style.css"
log "   Fetching: $URL_CSS"
RESPONSE_CSS=$(curl -s "$URL_CSS")

if [[ "$RESPONSE_CSS" == *"body { color: blue; }"* ]]; then
    success "CSS verified! Found 'body { color: blue; }'"
else
    error "CSS verification failed."
    echo "Response: $RESPONSE_CSS"
    exit 1
fi

success "🎉 Stage 4 Verification Complete! On-chain Web is working."
