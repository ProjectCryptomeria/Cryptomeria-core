#!/usr/bin/env bash
set -euo pipefail

# 共通ライブラリの読み込み
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

# テスト名定義
TEST_NAME="/render の修正（fragment.data参照・timeout/並列制限）が効いているか"

# 引数処理: --name のみ応答し、それ以外は通常実行
case "${1:-}" in
  --name) echo "$TEST_NAME"; exit 0;;
esac

# 必要なコマンドの確認
require_cmd kubectl

# --- 以下、テストロジック ---

PROJECT="render-$(date +%s)"
GWC_POD="$(gwc_pod)"
MDSC_POD="$(mdsc_pod)"

echo "--> Uploading sample content..."
# Upload sample content
kubectl exec -n "$NAMESPACE" "$GWC_POD" -- \
  gwcd tx gateway upload "index.html" "HELLO_RENDER" \
  --project-name "$PROJECT" --version "v1" --fragment-size 1024 \
  --from local-admin --chain-id gwc -y --output json --keyring-backend test --home /home/gwc/.gwc \
  --broadcast-mode sync

# マニフェストが公開されるのを待機
wait_manifest "$PROJECT" 240

echo "--> Verifying single render..."
# Single render should match
RESULT=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- curl -s "http://localhost:1317/render?project=$PROJECT&path=index.html")
echo "Result: $RESULT"

if [ "$RESULT" != "HELLO_RENDER" ]; then
  echo "❌ unexpected render output" >&2
  exit 1
fi

echo "--> Testing parallel stability..."
# Parallel render stability check (run inside the pod)
# 50回のリクエストを最大20並列で実行
kubectl exec -n "$NAMESPACE" "$GWC_POD" -- sh -c \
  "seq 1 50 | xargs -P 20 -I{} curl -sf 'http://localhost:1317/render?project=$PROJECT&path=index.html' >/dev/null" \
  && echo "OK: parallel render stable"