#!/bin/bash
set -e

NAMESPACE="cryptomeria"
TARGET_CHAIN="fdsc-0" # アップロード先

# 各Podの特定
GWC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")
RELAYER_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")
MDSC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=mdsc" -o jsonpath="{.items[0].metadata.name}")
# FDSCはターゲットチェーンIDからPod名を推測 (fdsc-0 -> cryptomeria-fdsc-0-0)
FDSC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/instance=$TARGET_CHAIN" -o jsonpath="{.items[0].metadata.name}")

MILLIONAIRE_KEY="local-admin"
LOG_FILE="/home/relayer/.relayer/relayer.log"

echo "=== Phase 3: E2E Integration Test (Upload & Verify) ==="

# 0. Pod検出確認
if [ -z "$FDSC_POD" ] || [ -z "$MDSC_POD" ]; then
    echo "❌ Error: Target pods (FDSC/MDSC) not found."
    exit 1
fi

# 1. Relayerプロセスの事前確認
echo "--> 🔍 Checking Relayer process..."
if ! kubectl exec -n $NAMESPACE $RELAYER_POD -- sh -c "pgrep -f 'rly start'" > /dev/null; then
    echo "❌ Fail: Relayer is NOT running. Please run 'just start-system' first."
    exit 1
fi

# 2. ログファイルの存在確認
echo "--> 🛠️  Checking Relayer log file..."
if ! kubectl exec -n $NAMESPACE $RELAYER_POD -- sh -c "[ -f $LOG_FILE ]"; then
    echo "❌ Error: Log file ($LOG_FILE) not found."
    exit 1
fi

# 3. 準備: テスト用ファイルの作成
TEST_FILE="/tmp/test-data-$(date +%s).bin"
echo "--> 📄 Creating dummy file (Random data)..."
kubectl exec -n $NAMESPACE $GWC_POD -- sh -c "dd if=/dev/urandom of=$TEST_FILE bs=1024 count=1 2>/dev/null"

# ログの現在位置（行数）を記録
START_LINE=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- sh -c "wc -l < $LOG_FILE" || echo "0")
START_LINE=$((START_LINE + 1))

# 4. Upload実行
echo "--> 📤 Submitting Upload Transaction..."
UPLOAD_CMD="gwcd tx gateway upload $TEST_FILE $TARGET_CHAIN --from $MILLIONAIRE_KEY --chain-id gwc -y --output json --keyring-backend test --home /home/gwc/.gwc"

TX_RES=$(kubectl exec -n $NAMESPACE $GWC_POD -- $UPLOAD_CMD)
TX_HASH=$(echo "$TX_RES" | jq -r '.txhash')

if [ -z "$TX_HASH" ] || [ "$TX_HASH" == "null" ]; then
    echo "❌ Fail: Upload transaction failed."
    echo "$TX_RES"
    exit 1
fi
echo "   TxHash: $TX_HASH"

# 5. Relayerログによる通信確認
echo "--> ⏳ Waiting for IBC Packet Delivery (Scanning Relayer logs)..."

MAX_WAIT=30
FOUND_PACKET=false
IBC_SUCCESS=false

for ((i=1; i<=MAX_WAIT; i++)); do
    LOG_OUTPUT=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- sh -c "tail -n +$START_LINE $LOG_FILE 2>/dev/null" || true)
    
    if echo "$LOG_OUTPUT" | grep -q "MsgRecvPacket"; then
        if [ "$FOUND_PACKET" = false ]; then
            echo "   ✅ Detected: Packet received on target chain."
            FOUND_PACKET=true
        fi
    fi
    
    if echo "$LOG_OUTPUT" | grep -q "MsgAcknowledgement"; then
        echo "   ✅ Detected: Acknowledgement received on GWC."
        IBC_SUCCESS=true
        break
    fi
    
    echo -n "."
    sleep 2
done

if [ "$IBC_SUCCESS" = false ]; then
    echo ""
    echo "❌ Timeout: IBC packet delivery not confirmed in logs."
    echo "Debug: Recent Relayer Logs:"
    kubectl exec -n $NAMESPACE $RELAYER_POD -- tail -n 20 $LOG_FILE
    exit 1
fi

# 6. データ永続化の確認 (Verification)
echo "--> 💾 Verifying Data Persistence on Storage Nodes..."

# A. FDSC (Data Fragment) の確認
echo "   🔍 Checking FDSC ($TARGET_CHAIN)..."
FDSC_OK=false
for i in {1..5}; do
    # list-fragment クエリを実行し、結果の配列長を確認
    COUNT=$(kubectl exec -n $NAMESPACE $FDSC_POD -- fdscd q datastore list-fragment -o json | jq '.fragment | length' 2>/dev/null || echo "0")
    if [ "$COUNT" -gt 0 ]; then
        echo "   ✅ FDSC: Data Fragment found! (Total Fragments: $COUNT)"
        FDSC_OK=true
        break
    fi
    sleep 2
done

# B. MDSC (Metadata Manifest) の確認
echo "   🔍 Checking MDSC (Metadata)..."
MDSC_OK=false
for i in {1..5}; do
    # list-manifest クエリを実行
    COUNT=$(kubectl exec -n $NAMESPACE $MDSC_POD -- mdscd q metastore list-manifest -o json | jq '.manifest | length' 2>/dev/null || echo "0")
    if [ "$COUNT" -gt 0 ]; then
        echo "   ✅ MDSC: Metadata Manifest found! (Total Manifests: $COUNT)"
        MDSC_OK=true
        break
    fi
    sleep 2
done

# 最終判定
if [ "$FDSC_OK" = true ] && [ "$MDSC_OK" = true ]; then
    echo "🎉 Success: Full End-to-End Test Passed!"
    echo "   - Upload Tx: OK"
    echo "   - IBC Relay: OK"
    echo "   - Storage Persistence: OK"
    exit 0
else
    echo "❌ Fail: Data verification failed."
    [ "$FDSC_OK" = false ] && echo "   - FDSC missing data."
    [ "$MDSC_OK" = false ] && echo "   - MDSC missing metadata."
    exit 1
fi