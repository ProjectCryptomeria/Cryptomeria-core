#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

echo "=== Phase 4-1: Single HTML Upload Test (Medium File: ~50KB) ==="

TARGET_CHAIN="fdsc-0"
FILENAME="index.html"
LOCAL_PATH="/tmp/$FILENAME"
REMOTE_PATH="/tmp/$FILENAME"

# 1. テストデータ作成 (約50KB)
log_step "📄 Generating 50KB dummy file..."

# 50KB (50 * 1024 = 51200 bytes) のランダムデータを生成
# Base64エンコードしてテキストとして扱う
dd if=/dev/urandom bs=1024 count=50 2>/dev/null | base64 | head -c 51200 > "$LOCAL_PATH"

# 念のためサイズを表示
FILE_SIZE=$(wc -c < "$LOCAL_PATH")
log_info "   Generated file size: $FILE_SIZE bytes"

# 2. GWCへ配置
push_to_gwc "$LOCAL_PATH" "$REMOTE_PATH"

# 3. アップロード
upload_and_wait "$REMOTE_PATH" "$TARGET_CHAIN"

# 4. 検証
verify_data "$TARGET_CHAIN" "$LOCAL_PATH"

log_success "Test 01 (Single HTML / 50KB) Passed!"