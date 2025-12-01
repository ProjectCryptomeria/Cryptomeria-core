#!/bin/bash
set -e

NAMESPACE="raidchain"
TEST_FILENAME="test-image.png"
# 期待されるデータ
EXPECTED_DATA="Hello_RaidChain_This_is_a_test_data_fragment_for_IBC_transfer_verification."

# 書き込み可能な一時ディレクトリを使用
OUTPUT_DIR="/tmp"
OUTPUT_FILE="$OUTPUT_DIR/$TEST_FILENAME"

log() { echo -e "\033[1;34m[TEST]\033[0m $1"; }
success() { echo -e "\033[1;32m[PASS]\033[0m $1"; }
error() { echo -e "\033[1;31m[ERROR]\033[0m $1"; }

log "🚀 Starting Proxy Download Test (Client -> GWC -> MDSC/FDSC)..."

GWC_POD=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/instance=gwc -o jsonpath="{.items[0].metadata.name}")

if [ -z "$GWC_POD" ]; then
    error "GWC Pod not found."
    exit 1
fi

# 前回の残骸を削除
kubectl exec -n "$NAMESPACE" "$GWC_POD" -- rm -f "$OUTPUT_FILE"

log "🔌 Triggering Download via GWC CLI..."
log "    Target File: $TEST_FILENAME"

# ダウンロード実行
kubectl exec -n "$NAMESPACE" "$GWC_POD" -- \
    gwcd q gateway download "$TEST_FILENAME" \
    --save-dir "$OUTPUT_DIR"

# 検証1: ファイルが存在するか
EXISTS=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- test -f "$OUTPUT_FILE" && echo "yes" || echo "no")
if [ "$EXISTS" != "yes" ]; then
    error "Downloaded file not found at $OUTPUT_FILE"
    exit 1
fi

# 検証2: 内容の照合 (MD5ハッシュ比較)
RESTORED_CONTENT=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- cat "$OUTPUT_FILE")

# Mac/Linux互換のため md5sum または md5 を使用
calc_md5() {
    echo -n "$1" | md5sum | awk '{print $1}' 2>/dev/null || echo -n "$1" | md5 | awk '{print $1}'
}

ORIGINAL_HASH=$(calc_md5 "$EXPECTED_DATA")
RESTORED_HASH=$(calc_md5 "$RESTORED_CONTENT")

log "✅ Verifying content integrity..."
log "    Original Hash: $ORIGINAL_HASH"
log "    Restored Hash: $RESTORED_HASH"

if [ "$ORIGINAL_HASH" == "$RESTORED_HASH" ]; then
    success "🎉 Success! Data retrieved via GWC proxy matches original."
    
    # 修正: リダイレクトをやめ、コマンド引数として渡し、サイズ数値のみ抽出する
    FILE_SIZE=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- wc -c "$OUTPUT_FILE" | awk '{print $1}')
    
    echo "      File Path: $OUTPUT_FILE"
    echo "      File Size: $FILE_SIZE bytes"
    echo "      Content  : $RESTORED_CONTENT"
else
    error "Data mismatch."
    echo "      Expected: $EXPECTED_DATA"
    echo "      Got     : $RESTORED_CONTENT"
    exit 1
fi