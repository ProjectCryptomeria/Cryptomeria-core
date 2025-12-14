#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

echo "=== Phase 4-3: Zip Archive Upload Test ==="

TARGET_CHAIN="fdsc-0"
# ユニークなプロジェクト名を使用
PROJECT_NAME="zip-site-project-$(date +%s)"
VERSION="2.0.0"
TEST_DIR="/tmp/phase4-zip-src"
ZIP_NAME="archive.zip"
LOCAL_ZIP="/tmp/$ZIP_NAME"
REMOTE_ZIP="/tmp/$ZIP_NAME"

# 1. データ作成 & Zip圧縮
mkdir -p "$TEST_DIR/assets"
create_html_file "$TEST_DIR/index.html" "HomePage"
echo "body { background: #000; }" > "$TEST_DIR/assets/style.css"

(cd "$TEST_DIR" && zip -r -q "$LOCAL_ZIP" .)
log_info "📦 Created Zip file."

# 2. GWCへ転送 & アップロード
push_to_gwc "$LOCAL_ZIP" "$REMOTE_ZIP"
upload_and_wait_v2 "$REMOTE_ZIP" "$TARGET_CHAIN" "$PROJECT_NAME" "$VERSION" 0

# 4. 検証 (Zip内のファイルが個別に復元できるか確認)
log_step "🧪 Verifying extracted content from Zip..."

# A. index.html
verify_data "$TARGET_CHAIN" "$TEST_DIR/index.html" "index.html" "$PROJECT_NAME"

# B. assets/style.css
verify_data "$TARGET_CHAIN" "$TEST_DIR/assets/style.css" "assets/style.css" "$PROJECT_NAME"

rm -rf "$TEST_DIR" "$LOCAL_ZIP"
log_success "Test 03 (Zip Archive & Extraction) Passed!"