#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

echo "=== Phase 4-2: Directory Content Upload Test ==="

TARGET_CHAIN="fdsc-0"
PROJECT_NAME="dir-test-project-$(date +%s)"
VERSION="0.1.0"
TEST_DIR="/tmp/test-site"
FRAGMENT_SIZE=10240 # 10KB (小さいファイルが多いので小さめでOK)

mkdir -p "$TEST_DIR/css" "$TEST_DIR/img"

# 1. データ作成
create_html_file "$TEST_DIR/index.html" "Home"
echo "body { color: red; }" > "$TEST_DIR/css/style.css"
echo "fake-image-binary" > "$TEST_DIR/img/logo.png"

# 2. 全ファイルをループして処理
find "$TEST_DIR" -type f | while read -r LOCAL_FILE; do
    REMOTE_PATH="/tmp/$(basename "$LOCAL_FILE")"
    
    log_step "📂 Processing: $(basename "$LOCAL_FILE")"
    push_to_gwc "$LOCAL_FILE" "$REMOTE_PATH"
    
    # アップロード
    upload_and_wait_v2 "$REMOTE_PATH" "$TARGET_CHAIN" "$PROJECT_NAME" "$VERSION" "$FRAGMENT_SIZE"
    
    # 検証
    verify_data "$TARGET_CHAIN" "$LOCAL_FILE" "$(basename "$LOCAL_FILE")" "$PROJECT_NAME"
done

rm -rf "$TEST_DIR"
log_success "Test 02 (Directory Content) Passed!"