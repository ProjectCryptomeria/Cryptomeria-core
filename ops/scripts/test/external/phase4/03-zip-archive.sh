#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

echo "=== Phase 4-3: Zip Archive Upload Test ==="

TARGET_CHAIN="fdsc-0"
TEST_DIR="/tmp/phase4-zip-src"
ZIP_NAME="archive.zip"
LOCAL_ZIP="/tmp/$ZIP_NAME"
REMOTE_ZIP="/tmp/$ZIP_NAME"

# 1. データ作成 & Zip圧縮
mkdir -p "$TEST_DIR"
create_html_file "$TEST_DIR/page1.html" "Page1"
create_html_file "$TEST_DIR/page2.html" "Page2"

# Zip作成 (quiet mode)
(cd "/tmp" && zip -r -q "$ZIP_NAME" "phase4-zip-src")

# 2. GWCへ転送
push_to_gwc "$LOCAL_ZIP" "$REMOTE_ZIP"

# 3. アップロード
upload_and_wait "$REMOTE_ZIP" "$TARGET_CHAIN"

# 4. 検証 (バイナリ一致確認)
verify_data "$TARGET_CHAIN" "$LOCAL_ZIP"

# 5. 解凍テスト (復元したZipが壊れていないか)
log_step "🧪 Testing Zip Integrity..."
# verify_data内で復元ロジックが完結しているため、再度手動で取得して解凍テストを行う
RESTORED_ZIP="/tmp/restored_$ZIP_NAME"
# FDSCからデータ取得
JSON=$(pod_exec "$(get_chain_pod_name $TARGET_CHAIN)" fdscd q datastore list-fragment -o json)
echo "$JSON" | jq -r '.fragment[-1].data' | base64 -d > "$RESTORED_ZIP"

if unzip -tq "$RESTORED_ZIP"; then
    log_success "Zip integrity check passed."
else
    log_error "Zip file is corrupted!"
fi

rm -rf "$TEST_DIR" "$LOCAL_ZIP" "$RESTORED_ZIP"
log_success "Test 03 (Zip Archive) Passed!"