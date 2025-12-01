#!/bin/bash
set -e

NAMESPACE="raidchain"
TEST_FILENAME="test-image.png"
EXPECTED_DATA="Hello_RaidChain_This_is_a_test_data_fragment_for_IBC_transfer_verification."
OUTPUT_FILE="/tmp/restored_data.txt"

log() { echo -e "\033[1;34m[TEST]\033[0m $1"; }
success() { echo -e "\033[1;32m[PASS]\033[0m $1"; }
error() { echo -e "\033[1;31m[ERROR]\033[0m $1"; }

log "🚀 Starting Proxy Download Test (Client -> GWC -> MDSC/FDSC)..."

# Pod名とIP/Service名の取得 (Kubernetesクラスタ内部で解決されるため不要だが、ログ用に残す)
MDSC_URL="http://raidchain-mdsc-0.raidchain-chain-headless.raidchain.svc.cluster.local:1317"
FDSC_URL="http://raidchain-fdsc-0-0.raidchain-chain-headless.raidchain.svc.cluster.local:1317"

GWC_POD=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/instance=gwc -o jsonpath="{.items[0].metadata.name}")

if [ -z "$GWC_POD" ]; then
    error "GWC Pod not found."
    exit 1
fi

log "🔌 Triggering Download via GWC CLI (No External Flags)..."
log "    Target File: $TEST_FILENAME"

# 修正: --output を --save-dir に変更
kubectl exec -n "$NAMESPACE" "$GWC_POD" -- \
    gwcd q gateway download "$TEST_FILENAME" \
    --save-dir "/tmp"

# 検証: Pod内のファイルをcatして内容確認
RESTORED_CONTENT=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- cat "/tmp/$TEST_FILENAME")

log "✅ Checking content..."
if [ "$RESTORED_CONTENT" == "$EXPECTED_DATA" ]; then
    success "🎉 Success! Data retrieved via GWC proxy matches original."
    echo "      Data: $RESTORED_CONTENT"
else
    error "Data mismatch."
    echo "      Expected: $EXPECTED_DATA"
    echo "      Got     : $RESTORED_CONTENT"
    exit 1
fi