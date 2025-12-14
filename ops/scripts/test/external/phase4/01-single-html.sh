#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

echo "=== Phase 4-1: Single HTML Upload Test (100KB File) ==="

TARGET_CHAIN="fdsc-0"
FILENAME="index.html"
LOCAL_PATH="/tmp/$FILENAME"
REMOTE_PATH="/tmp/$FILENAME"

# 1. テストデータ作成 (100KB)
log_step "📄 Generating 100KB dummy file..."

# 100KB (100 * 1024 = 102400 bytes) のランダムテキストデータを生成
dd if=/dev/urandom bs=1024 count=100 2>/dev/null | base64 | head -c 102400 > "$LOCAL_PATH"

# 念のためサイズを表示
FILE_SIZE=$(wc -c < "$LOCAL_PATH")
log_info "  Generated file size: $FILE_SIZE bytes"

# 2. GWCへ配置
push_to_gwc "$LOCAL_PATH" "$REMOTE_PATH"

# 3. アップロード & 永続化待機
# Txを送信し、ハッシュを取得
TX_HASH=$(upload_and_get_txhash "$REMOTE_PATH")

# 💡 Tx送信後、チャンク分割/IBCリレー/永続化が完了するまで待機
wait_for_data_persistence "$TARGET_CHAIN"

# 4. 検証
verify_data "$TARGET_CHAIN" "$LOCAL_PATH"

log_success "Test 01 (Single HTML / 100KB) Passed!"