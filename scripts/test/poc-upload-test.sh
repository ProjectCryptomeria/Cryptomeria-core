#!/bin/bash
set -e

# --- 設定 ---
NAMESPACE="raidchain"
# 修正: 新規ユーザーではなく、初期ジェネシスアカウントを使用する
USER_NAME="alice" 
CHAIN_ID_GWC="gwc"
TEST_FILENAME="test-image.png"
TEST_DATA="Hello_RaidChain_This_is_a_test_data_fragment_for_IBC_transfer_verification."

echo "🚀 Starting PoC Upload Test..."

# 1. ユーザー確認 (GWC)
echo "--> Using user '$USER_NAME' on GWC..."
GWC_POD=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/instance=gwc -o jsonpath="{.items[0].metadata.name}")

# キーが存在するか確認（なければエラーになるが、aliceは通常存在する）
# 念のためインポート済みか確認し、なければ回復...といった手順は複雑なので、
# ここでは「aliceは既にconfigに含まれている」前提で進めます。
# もしaliceがいない場合、mnemonicから復元する処理が必要ですが、
# k8sのdeploymentでは通常、初期化時にalice/bobが作成されます。

USER_ADDR=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd keys show $USER_NAME -a --keyring-backend test 2>/dev/null || echo "")

if [ -z "$USER_ADDR" ]; then
    echo "⚠️ User '$USER_NAME' not found in keyring. Attempting to recover from mnemonic..."
    # 開発環境用の固定ニーモニック (config.ymlで指定されているものがあればそれを使う)
    # ここでは例として適当なものを入れていますが、実際には初期化スクリプトで使われたものを指定する必要があります。
    # もしくは、Relayerのキー(cosmos...)にお金があるのでそれを使う手もあります。
    
    # 【代替案】Relayer用のアカウント(relayer)を使う
    # Relayerアカウントは確実に存在し、トークンも持っているはずです。
    echo "   -> Switching to 'relayer' account."
    USER_NAME="relayer"
    USER_ADDR=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd keys show $USER_NAME -a --keyring-backend test)
fi

echo "    User Address: $USER_ADDR"

# 2. アップロードトランザクション送信
echo "--> Sending Upload Transaction to GWC..."
# バランス確認（デバッグ用）
kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd q bank balances "$USER_ADDR"

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