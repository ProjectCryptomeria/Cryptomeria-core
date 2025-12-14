#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

echo "=== Phase 4-1: Single HTML Upload Test (100KB File) ==="

TARGET_CHAIN="fdsc-0"
FILENAME="index.html"
# ユニークなプロジェクト名を使用
PROJECT_NAME="single-test-project-$(date +%s)"
VERSION="1.0"
LOCAL_PATH="/tmp/$FILENAME"
REMOTE_PATH="/tmp/$FILENAME"

# 1. テストデータ作成
log_step "📄 Generating 100KB dummy file..."
dd if=/dev/urandom bs=1024 count=1000 2>/dev/null | base64 | head -c 10240000 > "$LOCAL_PATH"
FILE_SIZE=$(wc -c < "$LOCAL_PATH")
log_info "  Generated file size: $FILE_SIZE bytes"

# 2. GWCへ配置
push_to_gwc "$LOCAL_PATH" "$REMOTE_PATH"

# 3. アップロード
TX_HASH=$(upload_and_get_txhash "$REMOTE_PATH" "$PROJECT_NAME" "$VERSION" 0)

# 待機 (プロジェクト名を指定)
wait_for_data_persistence "$TARGET_CHAIN" "$PROJECT_NAME"

# 4. 検証 (プロジェクト名を指定)
verify_data "$TARGET_CHAIN" "$LOCAL_PATH" "$FILENAME" "$PROJECT_NAME"

log_success "Test 01 (Single HTML / 1000KB) Passed!"