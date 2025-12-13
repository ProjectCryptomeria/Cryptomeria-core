#!/bin/bash
set -e

NAMESPACE="cryptomeria"
TARGET_CHAIN="fdsc-0"
SCRIPT_TO_TEST="./ops/scripts/control/connect-chain.sh"

echo "=== Phase 2: Connect Chain Logic Test ($TARGET_CHAIN) ==="

# 1. スクリプト存在確認
if [ ! -f "$SCRIPT_TO_TEST" ]; then
    echo "❌ Fail: Script $SCRIPT_TO_TEST does not exist yet."
    exit 1
fi

# 2. 実行 (Connect Chain)
echo "--> 🚀 Executing Connect Script for $TARGET_CHAIN..."
"$SCRIPT_TO_TEST" "$TARGET_CHAIN" || { echo "❌ Script execution failed."; exit 1; }

echo "--> 🔍 Verifying State..."

# 必要なPod情報の再取得
RELAYER_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")
GWC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")

# 3. 鍵と残高の確認
KEY_NAME="relayer"
echo "   Checking Key '$KEY_NAME' on Relayer..."
# 【修正】gwcではなく、ターゲットチェーン(fdsc-0等)のキーを確認すべきです
if ! kubectl exec -n $NAMESPACE $RELAYER_POD -- rly keys show "$TARGET_CHAIN" "$KEY_NAME" > /dev/null 2>&1; then
    echo "❌ Fail: Relayer key '$KEY_NAME' for chain $TARGET_CHAIN not found."
    exit 1
fi

# 4. パス確立確認
echo "   Checking IBC Path..."
PATHS=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- rly paths list)
if echo "$PATHS" | grep -q "$TARGET_CHAIN"; then
    echo "✅ Pass: Path found in list."
else
    echo "❌ Fail: Path for $TARGET_CHAIN not found in 'rly paths list'."
    exit 1
fi

# 5. GWCへのストレージ登録確認 (リトライ機能付き)
echo "   Checking Storage Registration on GWC..."

MAX_RETRIES=10
for ((i=1; i<=MAX_RETRIES; i++)); do
    ENDPOINTS=$(kubectl exec -n $NAMESPACE $GWC_POD -- gwcd q gateway endpoints -o json)
    
    if echo "$ENDPOINTS" | grep -q "$TARGET_CHAIN"; then
        echo "✅ Pass: Chain $TARGET_CHAIN is registered in GWC storage endpoints."
        exit 0
    fi
    
    echo "   ⏳ ($i/$MAX_RETRIES) Waiting for registration to appear in block..."
    sleep 3
done

echo "❌ Fail: Chain $TARGET_CHAIN NOT found in GWC storage endpoints after retries."
echo "Debug: Last endpoints output:"
echo "$ENDPOINTS"
exit 1