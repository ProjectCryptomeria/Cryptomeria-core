#!/bin/bash
set -e

# ==========================================
# 設定
# ==========================================
BINARY="/workspace/apps/gwc/dist/gwcd"
NODE_URL="tcp://localhost:26657"
CHAIN_ID="gwc"
USER="alice"
PROJECT="k8s-test-project-v1-$(date +%Y%m%d%H%M%S)"

echo "🚀 Starting Signed Upload E2E Test against K8s..."
echo "Target Node: $NODE_URL"

# ---------------------------------------------------------
# Helper: トランザクション送信とエラーチェック
# ---------------------------------------------------------
submit_tx() {
    local cmd="$@"
    # stderrもstdoutにマージして取得
    local raw_output=$($cmd 2>&1)
    local exit_code=$?

    # コマンド自体の失敗
    if [ $exit_code -ne 0 ]; then
        echo "❌ Command failed with exit code $exit_code" >&2
        echo "$raw_output" >&2
        exit 1
    fi

    # "gas estimate:" などのノイズ行を除去してJSON部分のみ抽出
    # grep -v で "gas estimate" を含む行を除外
    local tx_json=$(echo "$raw_output" | grep -v "^gas estimate:")

    # JSONパース確認
    local code=$(echo "$tx_json" | jq -r '.code' 2>/dev/null)
    if [ -z "$code" ] || [ "$code" == "null" ]; then
        echo "❌ Failed to parse Tx response (Not JSON?)" >&2
        echo "⬇️  Raw Output:" >&2
        echo "$raw_output" >&2
        exit 1
    fi

    # CheckTx (Mempool) エラーの確認
    if [ "$code" != "0" ]; then
        echo "❌ CheckTx Failed (Mempool Error) code: $code" >&2
        echo "⬇️  Details:" >&2
        echo "$tx_json" | jq . >&2
        exit 1
    fi

    echo "$tx_json"
}

# ---------------------------------------------------------
# Helper: 完了待ち
# ---------------------------------------------------------
wait_for_tx() {
    local tx_hash=$1
    echo "   ⏳ Waiting for Tx ($tx_hash)..." >&2
    
    for i in {1..15}; do
        sleep 4
        # 標準エラー出力も含めて取得
        local result=$($BINARY query tx $tx_hash --node "$NODE_URL" --output json 2>&1 || true)
        
        # "not found" は無視してリトライ
        if echo "$result" | grep -q "not found"; then
            continue
        fi

        # codeを取得
        local code=$(echo "$result" | jq -r '.code' 2>/dev/null)

        if [ "$code" == "0" ]; then
            echo "$result"
            return 0
        elif [ -n "$code" ] && [ "$code" != "null" ]; then
            echo "❌ Tx failed on-chain with code: $code" >&2
            echo "⬇️  Raw Log:" >&2
            echo "$result" | jq -r '.raw_log' >&2
            exit 1
        else
            # JSONとしてパースできない、または予期せぬエラー
            if echo "$result" | grep -q "error"; then
                 echo "❌ Query failed:" >&2
                 echo "$result" >&2
                 exit 1
            fi
        fi
    done

    echo "❌ Timeout: Tx was not found in blocks." >&2
    exit 1
}

# ---------------------------------------------------------
# 0. 準備
# ---------------------------------------------------------
if ! command -v jq &> /dev/null; then echo "❌ jq missing"; exit 1; fi
if ! $BINARY keys show $USER --keyring-backend test &> /dev/null; then
  echo "❌ Key '$USER' not found."
  exit 1
fi

echo "📦 Creating test zip..."
mkdir -p /tmp/test-upload
echo "<html><h1>Hello Web3</h1></html>" > /tmp/test-upload/index.html
echo "body { background: #333; }" > /tmp/test-upload/style.css
cd /tmp/test-upload && zip -r ../test.zip ./* && cd - >/dev/null

# ---------------------------------------------------------
# 1. Init Upload
# ---------------------------------------------------------
echo "1️⃣  Init Upload..."
# 初回はガス指定なし(デフォルト)
INIT_TX_JSON=$(submit_tx $BINARY tx gateway init-upload "$PROJECT" 1024 \
  --from $USER --chain-id $CHAIN_ID --node "$NODE_URL" --keyring-backend test \
  -y -o json)

INIT_TX_HASH=$(echo $INIT_TX_JSON | jq -r '.txhash')
echo "   Tx Hash: $INIT_TX_HASH"

# 完了待ち
TX_RESULT=$(wait_for_tx "$INIT_TX_HASH")

UPLOAD_ID=$(echo "$TX_RESULT" | jq -r '.events[]? | select(.type=="init_upload") | .attributes[]? | select(.key=="upload_id") | .value')

if [ -z "$UPLOAD_ID" ] || [ "$UPLOAD_ID" == "null" ]; then
    echo "⚠️  Could not auto-detect UploadID. Raw result:"
    echo "$TX_RESULT" | jq .
    exit 1
fi
echo "✅ UploadID: $UPLOAD_ID"

# ---------------------------------------------------------
# 2. Post Chunk
# ---------------------------------------------------------
echo "2️⃣  Post Chunk..."
# ここで --gas auto を使うため "gas estimate" が出る可能性がある
CHUNK_TX_JSON=$(submit_tx $BINARY tx gateway post-chunk "$UPLOAD_ID" 0 /tmp/test.zip \
  --from $USER --chain-id $CHAIN_ID --node "$NODE_URL" --keyring-backend test \
  --gas auto --gas-adjustment 1.5 \
  -y -o json)
CHUNK_TX_HASH=$(echo $CHUNK_TX_JSON | jq -r '.txhash')
wait_for_tx "$CHUNK_TX_HASH" > /dev/null
echo "   Chunk committed."

# ---------------------------------------------------------
# 3. Complete Upload
# ---------------------------------------------------------
echo "3️⃣  Complete Upload..."
COMP_TX_JSON=$(submit_tx $BINARY tx gateway complete-upload "$UPLOAD_ID" "$PROJECT" "1.0.0" 1024 \
  --from $USER --chain-id $CHAIN_ID --node "$NODE_URL" --keyring-backend test \
  --gas auto --gas-adjustment 1.5 \
  -y -o json)
COMP_TX_HASH=$(echo $COMP_TX_JSON | jq -r '.txhash')
COMP_RESULT=$(wait_for_tx "$COMP_TX_HASH")

SITE_ROOT=$(echo "$COMP_RESULT" | jq -r '.events[]? | select(.type=="complete_upload") | .attributes[]? | select(.key=="site_root") | .value')

if [ -z "$SITE_ROOT" ] || [ "$SITE_ROOT" == "null" ]; then
    echo "❌ SiteRoot not found in events. Raw logs:"
    echo "$COMP_RESULT" | jq -r '.raw_log'
    exit 1
fi
echo "✅ SiteRoot: $SITE_ROOT"

# ---------------------------------------------------------
# 4. Sign Upload
# ---------------------------------------------------------
echo "4️⃣  Sign Upload..."
DUMMY_SIG="c2lnbmF0dXJl" 
SIGN_TX_JSON=$(submit_tx $BINARY tx gateway sign-upload "$UPLOAD_ID" "$SITE_ROOT" "$DUMMY_SIG" \
  --from $USER --chain-id $CHAIN_ID --node "$NODE_URL" --keyring-backend test \
  --gas auto --gas-adjustment 1.5 \
  -y -o json)
SIGN_TX_HASH=$(echo $SIGN_TX_JSON | jq -r '.txhash')
wait_for_tx "$SIGN_TX_HASH" > /dev/null

echo "✅ Flow Finished!"