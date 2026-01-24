#!/bin/bash
set -e
source "$(dirname "$0")/../../lib/common.sh"

echo "=== Storage Data Verification & Reconstruction ==="

# =============================================================================
# 0. Target Pods
# =============================================================================
GWC_POD=$(get_chain_pod_name "gwc")
MDSC_POD=$(get_chain_pod_name "mdsc")

if [ -z "$GWC_POD" ] || [ -z "$MDSC_POD" ]; then
  log_error "Target pods not found. Is the system running?"
fi


# =============================================================================
# 1. MDSC: Metadata (Manifest) Inspection
# =============================================================================
log_step "1) Querying MDSC for metadata (manifests)..."

MANIFESTS_JSON=$(pod_exec "$MDSC_POD" mdscd q metastore list-manifest -o json)

echo "--- [MDSC Stored Data Structure] ---"
echo "$MANIFESTS_JSON" | jq '.'
echo "------------------------------------"

COUNT=$(echo "$MANIFESTS_JSON" | jq '.manifest | length')
if [ "$COUNT" -eq 0 ]; then
  log_warn "No manifests found in MDSC. (Nothing to verify yet.)"
  exit 0
fi
log_success "Found $COUNT manifest(s) in MDSC."

# Pick the last manifest's project_name (best-effort)
LATEST_PROJECT=$(echo "$MANIFESTS_JSON" | jq -r '.manifest[-1].project_name')
if [ -z "$LATEST_PROJECT" ] || [ "$LATEST_PROJECT" = "null" ]; then
  log_error "Failed to pick a project_name from list-manifest output."
fi

log_step "2) Showing manifest for project: $LATEST_PROJECT"
MANIFEST_JSON=$(pod_exec "$MDSC_POD" mdscd q metastore get-manifest "$LATEST_PROJECT" -o json)

echo "--- [Selected Manifest] ---"
# 新しい検証用フィールド(SiteRoot, Signature)を含めて表示
echo "$MANIFEST_JSON" | jq '{
  project_name: .project_name,
  version: .version,
  creator: .creator,
  site_root: .site_root,
  client_signature: .client_signature,
  fragment_size: .fragment_size,
  files: .files
}'
echo "---------------------------"

# =============================================================================
# 2. Resolve fragment location using GWC endpoints (channel_id -> chain_id)
# =============================================================================
log_step "3) Resolving fragment location via manifest + gwc endpoints..."

FILE_KEY=$(echo "$MANIFEST_JSON" | jq -r '.files | keys[0]')
if [ -z "$FILE_KEY" ] || [ "$FILE_KEY" = "null" ]; then
  log_error "No files found in selected manifest."
fi

FDSC_CHANNEL=$(echo "$MANIFEST_JSON" | jq -r --arg K "$FILE_KEY" '.files[$K].fragments[0].fdsc_id')
FRAGMENT_ID=$(echo "$MANIFEST_JSON" | jq -r --arg K "$FILE_KEY" '.files[$K].fragments[0].fragment_id')

if [ -z "$FDSC_CHANNEL" ] || [ "$FDSC_CHANNEL" = "null" ] || [ -z "$FRAGMENT_ID" ] || [ "$FRAGMENT_ID" = "null" ]; then
  log_error "Failed to extract fragment mapping from manifest."
fi

ENDPOINTS_JSON=$(pod_exec "$GWC_POD" gwcd q gateway endpoints -o json)
FDSC_CHAIN=$(echo "$ENDPOINTS_JSON" | jq -r --arg CH "$FDSC_CHANNEL" '.storage_infos[] | select(.channel_id==$CH) | .chain_id' | head -n 1)
if [ -z "$FDSC_CHAIN" ] || [ "$FDSC_CHAIN" = "null" ]; then
  log_error "Could not resolve fdsc chain id for channel '$FDSC_CHANNEL'."
fi

FDSC_POD=$(get_chain_pod_name "$FDSC_CHAIN")
if [ -z "$FDSC_POD" ]; then
  log_error "FDSC pod not found for chain '$FDSC_CHAIN'."
fi

log_success "Resolved fragment: project=$LATEST_PROJECT file=$FILE_KEY channel=$FDSC_CHANNEL chain=$FDSC_CHAIN fragment_id=$FRAGMENT_ID"

# =============================================================================
# 3. FDSC: Fragment Inspection
# =============================================================================
log_step "4) Querying FDSC ($FDSC_CHAIN) for fragment..."
FRAG_JSON=$(pod_exec "$FDSC_POD" fdscd q datastore get-fragment "$FRAGMENT_ID" -o json)

echo "--- [Fragment JSON] ---"
# Fragment側にも site_root が付与されているか確認
echo "$FRAG_JSON" | jq .
echo "------------------------"

# =============================================================================
# 4. Data Reconstruction (single fragment preview)
# =============================================================================
log_step "5) Reconstructing data from fragment (preview)..."

RAW_CONTENT_BASE64=$(echo "$FRAG_JSON" | jq -r '.fragment.data')
if [ -z "$RAW_CONTENT_BASE64" ] || [ "$RAW_CONTENT_BASE64" = "null" ]; then
  log_error "Failed to extract data from fragment."
fi

echo "   Extracted base64 prefix: ${RAW_CONTENT_BASE64:0:50}..."

RECONSTRUCTED_FILE="/tmp/reconstructed_data.bin"
echo "$RAW_CONTENT_BASE64" | base64 -d > "$RECONSTRUCTED_FILE"

echo "--- [Reconstructed Data Preview] ---"
if command -v xxd >/dev/null; then
  xxd "$RECONSTRUCTED_FILE" | head -n 10
elif command -v hexdump >/dev/null; then
  hexdump -C "$RECONSTRUCTED_FILE" | head -n 10
else
  cat "$RECONSTRUCTED_FILE"
fi
echo "----------------------------------"

log_success "Verification finished."