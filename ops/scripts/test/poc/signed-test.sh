#!/bin/bash
set -e

# ==========================================
# 設定 (Kubernetes環境に合わせて調整)
# ==========================================
BINARY="/workspace/apps/gwc/dist/gwcd" 
# ポートフォワードしている場合は localhost:26657
NODE_URL="tcp://localhost:26657"
CHAIN_ID="gwc" # k8s環境のチェーンID (values.yaml等で設定したもの)
USER="alice"   # テスト用アカウント (ローカルのキーリングに存在する必要があります)
PROJECT="k8s-test-project-v1"

echo "🚀 Starting Signed Upload E2E Test against K8s..."
echo "Target Node: $NODE_URL"
echo "Chain ID:    $CHAIN_ID"

# ---------------------------------------------------------
# 事前チェック: キーの存在確認
# ---------------------------------------------------------
if ! $BINARY keys show $USER --keyring-backend test &> /dev/null; then
  echo "❌ Key '$USER' not found in local keyring."
  echo "👉 Please import the key first:"
  echo "   $BINARY keys add $USER --recover --keyring-backend test"
  exit 1
fi

# ---------------------------------------------------------
# 0. テスト用データの準備
# ---------------------------------------------------------
echo "📦 Creating test zip..."
mkdir -p /tmp/test-upload
echo "<html><h1>Hello Web3 on K8s</h1></html>" > /tmp/test-upload/index.html
echo "body { background: #333; color: white; }" > /tmp/test-upload/style.css
# Zip作成
cd /tmp/test-upload && zip -r ../test.zip ./* && cd -

# ---------------------------------------------------------
# 1. アップロードセッション開始 (Init)
# ---------------------------------------------------------
echo "1️⃣  Init Upload..."
INIT_TX=$($BINARY tx gateway init-upload "$PROJECT" 1024 \
  --from $USER \
  --chain-id $CHAIN_ID \
  --node "$NODE_URL" \
  --keyring-backend test \
  -y -o json)

echo "   Tx sent. Waiting for block..."
sleep 6 # k8s環境はブロック生成が遅い場合があるので長めに待つ

# ※ 本来はTxハッシュからイベントを検索すべきですが、簡易的に手動入力を促します
echo "⚠️  Since we cannot easily grep events from remote node logs via CLI only,"
echo "    please check the 'gwcd' pod logs in k8s for 'Upload session initialized'."
echo "    (e.g., kubectl logs -l app=gwc -f)"
echo ""
echo -n "👉 Enter UploadID from k8s logs: "
read UPLOAD_ID

if [ -z "$UPLOAD_ID" ]; then
  echo "❌ UploadID is required."
  exit 1
fi

# ---------------------------------------------------------
# 2. データ送信 (PostChunk)
# ---------------------------------------------------------
echo "2️⃣  Post Chunk..."
$BINARY tx gateway post-chunk "$UPLOAD_ID" 0 /tmp/test.zip \
  --from $USER \
  --chain-id $CHAIN_ID \
  --node "$NODE_URL" \
  --keyring-backend test \
  -y

echo "   Chunk sent. Waiting for block..."
sleep 6

# ---------------------------------------------------------
# 3. 完了通知 & Root計算 (Complete)
# ---------------------------------------------------------
echo "3️⃣  Complete Upload (Request SiteRoot)..."
$BINARY tx gateway complete-upload "$UPLOAD_ID" "test.zip" "1.0.0" 1024 \
  --from $USER \
  --chain-id $CHAIN_ID \
  --node "$NODE_URL" \
  --keyring-backend test \
  -y

echo "   Complete request sent. Waiting for block..."
sleep 6

echo "👀 Check k8s logs! The node should have calculated the SiteRoot."
echo "   Look for: 'Upload processed, waiting for sign'"
echo ""
echo -n "👉 Enter Calculated SiteRoot (from k8s logs): "
read SITE_ROOT

if [ -z "$SITE_ROOT" ]; then
  echo "❌ SiteRoot is required."
  exit 1
fi

# ---------------------------------------------------------
# 4. 署名送信 (Sign)
# ---------------------------------------------------------
echo "4️⃣  Sign Upload..."
# ダミー署名 (Base64)
DUMMY_SIG="c2lnbmF0dXJl" 

$BINARY tx gateway sign-upload "$UPLOAD_ID" "$SITE_ROOT" "$DUMMY_SIG" \
  --from $USER \
  --chain-id $CHAIN_ID \
  --node "$NODE_URL" \
  --keyring-backend test \
  -y

echo "✅ Flow Finished! Check logs for 'Distribution started'."