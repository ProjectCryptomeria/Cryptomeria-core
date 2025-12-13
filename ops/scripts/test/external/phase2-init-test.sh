#!/bin/bash
set -e

NAMESPACE="cryptomeria"
SCRIPT_TO_TEST="./ops/scripts/control/init-relayer.sh"

echo "=== Phase 2: Relayer Initialization Logic Test ==="

# 1. リレイヤーPodの特定
echo "--> 🔍 Finding Relayer Pod..."
RELAYER_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")
if [ -z "$RELAYER_POD" ]; then
    echo "❌ Error: Relayer pod not found."
    exit 1
fi
echo "   Target Pod: $RELAYER_POD"

# 2. 初期状態の確認 (空であるべき)
echo "--> 1️⃣ Checking Pre-condition (Should be empty)..."
# config showが失敗するか、出力が空ならOK
if kubectl exec -n $NAMESPACE $RELAYER_POD -- rly config show > /dev/null 2>&1; then
    PRE_CONFIG=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- rly config show 2>/dev/null)
    if echo "$PRE_CONFIG" | grep -q "chain-id"; then
        echo "⚠️ Warning: Relayer already has config. Cleaning up for test..."
        # テストのために一旦消す
        kubectl exec -n $NAMESPACE $RELAYER_POD -- rm -rf /home/relayer/.relayer/config
    fi
fi
echo "   ✅ Pre-condition OK."

# 3. 実装予定のスクリプトを実行
echo "--> 2️⃣ Executing Initialization Script..."
if [ ! -f "$SCRIPT_TO_TEST" ]; then
    echo "❌ Fail: Script $SCRIPT_TO_TEST does not exist yet."
    echo "   (This is expected for TDD step 1)"
    exit 1
fi

# スクリプト実行
"$SCRIPT_TO_TEST"

# 4. 実行後の状態確認 (設定が入っているべき)
echo "--> 3️⃣ Checking Post-condition..."
POST_CONFIG=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- rly config show 2>/dev/null)

# チェック項目: GWC, MDSC, FDSCが含まれているか
MISSING=""
echo "$POST_CONFIG" | grep -q "gwc" || MISSING="$MISSING gwc"
echo "$POST_CONFIG" | grep -q "mdsc" || MISSING="$MISSING mdsc"
echo "$POST_CONFIG" | grep -q "fdsc-0" || MISSING="$MISSING fdsc-0"

if [ -n "$MISSING" ]; then
    echo "❌ Fail: Missing chain configurations: $MISSING"
    echo "   Current Config:"
    echo "$POST_CONFIG"
    exit 1
else
    echo "✅ Pass: All chains (gwc, mdsc, fdsc-0) are configured."
fi

echo "=== Test Complete ==="