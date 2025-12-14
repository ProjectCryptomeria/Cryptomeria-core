#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

echo "=== Phase 4-2: Directory Content Upload Test ==="

TARGET_CHAIN="fdsc-0"
TEST_DIR="/tmp/test-site"
mkdir -p "$TEST_DIR/css" "$TEST_DIR/img"

# 1. ディレクトリ構造とファイル作成
create_html_file "$TEST_DIR/index.html" "Home"
echo "body { color: red; }" > "$TEST_DIR/css/style.css"
echo "fake-image-binary" > "$TEST_DIR/img/logo.png"

# 2. 全ファイルをループして処理
# findコマンドでファイル一覧を取得
find "$TEST_DIR" -type f | while read -r LOCAL_FILE; do
    REL_PATH="${LOCAL_FILE#$TEST_DIR/}" # 相対パス
    REMOTE_PATH="/tmp/$(basename "$LOCAL_FILE")" # GWC上ではフラットに置く（アップロードテストのため）
    
    log_step "📂 Processing: $REL_PATH"
    
    # GWCへ転送
    push_to_gwc "$LOCAL_FILE" "$REMOTE_PATH"
    
    # アップロード
    upload_and_wait "$REMOTE_PATH" "$TARGET_CHAIN"
    
    # 検証
    verify_data "$TARGET_CHAIN" "$LOCAL_FILE"
done

rm -rf "$TEST_DIR"
log_success "Test 02 (Directory Content) Passed!"