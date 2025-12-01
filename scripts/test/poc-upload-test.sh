#!/bin/bash
set -e

# --- 設定 ---
NAMESPACE="raidchain"
USER_NAME="user1"
CHAIN_ID_GWC="gwc"
TEST_FILENAME="test-image.png"
TEST_DATA="Hello_RaidChain_This_is_a_test_data_fragment_for_IBC_transfer_verification."

echo "🚀 Starting PoC Upload Test..."

# 1. ユーザー作成 (GWC)
echo "--> Creating user on GWC..."
# [削除] Relayerのキー復元は不要なので削除
# kubectl exec -n "$NAMESPACE" -it deployment/raidchain-relayer -- rly keys restore ...

GWC_POD=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/instance=gwc -o jsonpath="{.items[0].metadata.name}")

# GWC内にユーザーを作成（既に存在してもエラーにならないよう || true をつける）
kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd keys add $USER_NAME --keyring-backend test 2>/dev/null || true
USER_ADDR=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd keys show $USER_NAME -a --keyring-backend test)
echo "    User Address: $USER_ADDR"

# 2. アップロードトランザクション送信
echo "--> Sending Upload Transaction to GWC..."
kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd tx gateway upload "$TEST_FILENAME" "$TEST_DATA" \
    --from $USER_NAME --chain-id $CHAIN_ID_GWC --keyring-backend test -y

echo "✅ Transaction sent. Waiting for Relayer to transport packets (20s)..."
sleep 20

# 3. FDSCでのデータ確認 (Fragment)
echo "--> Checking FDSC for Fragments..."
FDSC_POD=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/instance=fdsc-0 -o jsonpath="{.items[0].metadata.name}")
FRAGMENTS=$(kubectl exec -n "$NAMESPACE" "$FDSC_POD" -- fdscd q datastore list-fragment -o json)
echo "$FRAGMENTS" | jq .

# 判定
COUNT=$(echo "$FRAGMENTS" | jq '.fragment | length')
if [ "$COUNT" -gt 0 ]; then
    echo "🎉 Success: Found $COUNT fragments in FDSC!"
else
    echo "❌ Error: No fragments found in FDSC."
fi

# 4. MDSCでのデータ確認 (Manifest)
echo "--> Checking MDSC for Manifest..."
MDSC_POD=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/instance=mdsc -o jsonpath="{.items[0].metadata.name}")
MANIFESTS=$(kubectl exec -n "$NAMESPACE" "$MDSC_POD" -- mdscd q metastore list-manifest -o json)
echo "$MANIFESTS" | jq .

# 判定
M_COUNT=$(echo "$MANIFESTS" | jq '.manifest | length')
if [ "$M_COUNT" -gt 0 ]; then
    echo "🎉 Success: Found $M_COUNT manifest(s) in MDSC!"
    echo "    Project Name: $(echo "$MANIFESTS" | jq -r '.manifest[0].project_name')"
else
    echo "❌ Error: No manifest found in MDSC."
fi

echo "--- Test Complete ---"