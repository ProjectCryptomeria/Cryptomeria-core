#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

echo "=== Phase 4-1: Single HTML Upload Test ==="

TARGET_CHAIN="fdsc-0"
FILENAME="index.html"
LOCAL_PATH="/tmp/$FILENAME"
REMOTE_PATH="/tmp/$FILENAME"

# 1. テストデータ作成
create_html_file "$LOCAL_PATH" "Phase4-Index"

# 2. GWCへ配置
push_to_gwc "$LOCAL_PATH" "$REMOTE_PATH"

# 3. アップロード
upload_and_wait "$REMOTE_PATH" "$TARGET_CHAIN"

# 4. 検証
verify_data "$TARGET_CHAIN" "$LOCAL_PATH"

log_success "Test 01 (Single HTML) Passed!"