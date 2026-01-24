#!/bin/bash
set -e

# ==========================================
# 設定 (Kubernetes環境に合わせて調整)
# ==========================================
BINARY="/workspace/apps/gwc/dist/gwcd"
NODE_URL="tcp://localhost:26657"
CHAIN_ID="gwc"
USER="alice"
PROJECT="k8s-test-project-v1"

echo "🚀 Starting Signed Upload E2E Test against K8s..."
echo "Target Node: $NODE_URL"
echo "Chain ID:    $CHAIN_ID"

# ---------------------------------------------------------
# 依存ツールチェック
# ---------------------------------------------------------
if ! command -v jq &> /dev/null; then
    echo "❌ 'jq' command not found. Please install jq."
    exit 1
fi

# ---------------------------------------------------------
# Helper関数: トランザクション完了待ち & 結果取得
# ---------------------------------------------------------
wait_for_tx() {
    local tx_hash=$1
    # 修正ポイント: ログは標準エラー出力(>&2)に出して、変数に入らないようにする
    echo "   ⏳ Waiting for Tx ($tx_hash) to be committed..." >&2
    
    for i in {1..12}; do
        sleep 5
        set +e
        local result=$($BINARY query tx $tx_hash --node "$NODE_URL" --output json 2>/dev/null)
        local exit_code=$?
        set -e

        if [ $exit_code -eq 0 ]; then
            local code=$(echo "$result" | jq -r '.code')
            
            if [ "$code" == "0" ]; then
                # 成功時のみJSONを標準出力に返す
                echo "$result"
                return 0
            else
                echo "❌ Tx failed with code: $code" >&2
                echo "$result" >&2
                exit 1
            fi
        fi
    done

    echo "❌ Timeout waiting for Tx commit." >&2
    exit 1
}

# ---------------------------------------------------------
# 事前チェック
# ---------------------------------------------------------
if ! $BINARY keys show $USER --keyring-backend test &> /dev/null; then
  echo "❌ Key '$USER' not found. Please import key first."
  exit 1
fi

# ---------------------------------------------------------
# 0. テストデータ準備
# ---------------------------------------------------------
echo "📦 Creating test zip..."
mkdir -p /tmp/test-upload
echo "<html><h1>Hello Web3</h1></html>" > /tmp/test-upload/index.html
echo "body { background: #333; }" > /tmp/test-upload/style.css
cd /tmp/test-upload && zip -r ../test.zip ./* && cd - >/dev/null

# ---------------------------------------------------------
# 1. Init Upload
# ---------------------------------------------------------
echo "1️⃣  Init Upload..."

INIT_TX_JSON=$($BINARY tx gateway init-upload "$PROJECT" 1024 \
  --from $USER --chain-id $CHAIN_ID --node "$NODE_URL" --keyring-backend test -y -o json)

INIT_TX_HASH=$(echo $INIT_TX_JSON | jq -r '.txhash')
echo "   Tx Hash: $INIT_TX_HASH"

# 完了待ち
TX_RESULT=$(wait_for_tx "$INIT_TX_HASH")

# UploadID抽出
UPLOAD_ID=$(echo "$TX_RESULT" | jq -r '.events[]? | select(.type=="init_upload") | .attributes[]? | select(.key=="upload_id") | .value')

if [ -z "$UPLOAD_ID" ] || [ "$UPLOAD_ID" == "null" ]; then
    echo "⚠️  Could not auto-detect UploadID."
    echo "    JSON dump for debug:"
    echo "$TX_RESULT" | jq .
    echo -n "👉 Enter UploadID manually: "
    read UPLOAD_ID
else
    echo "✅ Auto-detected UploadID: $UPLOAD_ID"
fi

if [ -z "$UPLOAD_ID" ]; then echo "❌ UploadID required."; exit 1; fi

# ---------------------------------------------------------
# 2. Post Chunk
# ---------------------------------------------------------
echo "2️⃣  Post Chunk..."
CHUNK_TX_JSON=$($BINARY tx gateway post-chunk "$UPLOAD_ID" 0 /tmp/test.zip \
  --from $USER --chain-id $CHAIN_ID --node "$NODE_URL" --keyring-backend test -y -o json)
CHUNK_TX_HASH=$(echo $CHUNK_TX_JSON | jq -r '.txhash')
wait_for_tx "$CHUNK_TX_HASH" > /dev/null
echo "   Chunk committed."

# ---------------------------------------------------------
# 3. Complete Upload
# ---------------------------------------------------------
echo "3️⃣  Complete Upload..."
COMP_TX_JSON=$($BINARY tx gateway complete-upload "$UPLOAD_ID" "test.zip" "1.0.0" 1024 \
  --from $USER --chain-id $CHAIN_ID --node "$NODE_URL" --keyring-backend test -y -o json)
COMP_TX_HASH=$(echo $COMP_TX_JSON | jq -r '.txhash')
COMP_RESULT=$(wait_for_tx "$COMP_TX_HASH")

# 修正: Go側で complete_upload イベントを追加していない場合、ログから探す必要がある
# ここでは自動取得を試みて、だめなら手動入力に倒す
SITE_ROOT=$(echo "$COMP_RESULT" | jq -r '.events[]? | select(.type=="complete_upload") | .attributes[]? | select(.key=="site_root") | .value')

if [ -z "$SITE_ROOT" ] || [ "$SITE_ROOT" == "null" ]; then
    echo "👀 SiteRoot Check Required!"
    echo "   Please check k8s logs for 'site_root'."
    echo -n "👉 Enter Calculated SiteRoot: "
    read SITE_ROOT
else
    echo "✅ Auto-detected SiteRoot: $SITE_ROOT"
fi

if [ -z "$SITE_ROOT" ]; then echo "❌ SiteRoot required."; exit 1; fi

# ---------------------------------------------------------
# 4. Sign Upload
# ---------------------------------------------------------
echo "4️⃣  Sign Upload..."
DUMMY_SIG="c2lnbmF0dXJl" 
SIGN_TX_JSON=$($BINARY tx gateway sign-upload "$UPLOAD_ID" "$SITE_ROOT" "$DUMMY_SIG" \
  --from $USER --chain-id $CHAIN_ID --node "$NODE_URL" --keyring-backend test -y -o json)
SIGN_TX_HASH=$(echo $SIGN_TX_JSON | jq -r '.txhash')
wait_for_tx "$SIGN_TX_HASH" > /dev/null

echo "✅ Flow Finished! Check logs for 'Distribution started'."