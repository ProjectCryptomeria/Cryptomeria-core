#!/bin/bash
set -e
source "$(dirname "$0")/../../lib/common.sh"

echo "=== 🕵️‍♀️ Storage Data Verification & Reconstruction ==="

# 1. ターゲットの特定
MDSC_POD=$(get_chain_pod_name "mdsc")
# FDSCは複数ある可能性があるが、ここでは fdsc-0 を代表として確認
FDSC_CHAIN="fdsc-0"
FDSC_POD=$(get_chain_pod_name "$FDSC_CHAIN")

if [ -z "$MDSC_POD" ] || [ -z "$FDSC_POD" ]; then
    log_error "Target pods not found. Is the system running?"
fi

# =============================================================================
# 1. MDSC: Metadata (Manifest) Inspection
# =============================================================================
log_step "1️⃣  Querying MDSC for Metadata (Manifests)..."

# JSONを取得
MANIFESTS_JSON=$(pod_exec "$MDSC_POD" mdscd q metastore list-manifest -o json)

# 生のJSON構造を表示
echo "--- [MDSC Stored Data Structure] ---"
echo "$MANIFESTS_JSON" | jq '.'
echo "------------------------------------"

# 件数チェック
COUNT=$(echo "$MANIFESTS_JSON" | jq '.manifest | length')
if [ "$COUNT" -eq 0 ]; then
    log_warn "No manifests found in MDSC."
else
    log_success "Found $COUNT manifest(s) in MDSC."
fi

# =============================================================================
# 2. FDSC: File Data (Fragment) Inspection
# =============================================================================
log_step "2️⃣  Querying FDSC ($FDSC_CHAIN) for File Data (Fragments)..."

# JSONを取得
FRAGMENTS_JSON=$(pod_exec "$FDSC_POD" fdscd q datastore list-fragment -o json)

# 生のJSON構造を表示
echo "--- [FDSC Stored Data Structure] ---"
echo "$FRAGMENTS_JSON" | jq '.'
echo "------------------------------------"

# 件数チェック
F_COUNT=$(echo "$FRAGMENTS_JSON" | jq '.fragment | length')
if [ "$F_COUNT" -eq 0 ]; then
    log_error "No fragments found in FDSC. Cannot reconstruct data."
else
    log_success "Found $F_COUNT fragment(s) in FDSC."
fi

# =============================================================================
# 3. Data Reconstruction (Rebuild)
# =============================================================================
log_step "3️⃣  Reconstructing Data from Fragments..."

# 最新のフラグメントを取得 (IDが最大のものを想定)
# 【修正】フィールド名を .content から .data に変更
RAW_CONTENT_BASE64=$(echo "$FRAGMENTS_JSON" | jq -r '.fragment[-1].data')

if [ -z "$RAW_CONTENT_BASE64" ] || [ "$RAW_CONTENT_BASE64" == "null" ]; then
    log_error "Failed to extract content from fragment."
fi

echo "   🧩 Extracted Content (Base64): ${RAW_CONTENT_BASE64:0:50}..."

# 一時ファイルにデコード
RECONSTRUCTED_FILE="/tmp/reconstructed_data.bin"

# Base64デコード
echo "$RAW_CONTENT_BASE64" | base64 -d > "$RECONSTRUCTED_FILE"

echo ""
echo "--- [Reconstructed Data Preview (Hexdump)] ---"
if command -v xxd >/dev/null; then
    xxd "$RECONSTRUCTED_FILE" | head -n 10
elif command -v hexdump >/dev/null; then
    hexdump -C "$RECONSTRUCTED_FILE" | head -n 10
else
    echo "⚠️  'xxd' or 'hexdump' not found. Displaying as text:"
    cat "$RECONSTRUCTED_FILE"
fi
echo "----------------------------------------------"

log_success "Data reconstruction complete! Verification finished."