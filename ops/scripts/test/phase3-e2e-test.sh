#!/bin/bash
set -e

NAMESPACE="cryptomeria"
TARGET_CHAIN="fdsc-0"
GWC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")
RELAYER_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")
MILLIONAIRE_KEY="millionaire"
LOG_FILE="/home/relayer/.relayer/relayer.log"

echo "=== Phase 3: E2E Integration Test (Upload & Verify) ==="

# 0. Relayerプロセスの事前確認
echo "--> 🔍 Checking Relayer process..."
if ! kubectl exec -n $NAMESPACE $RELAYER_POD -- pgrep -f "rly start" > /dev/null; then
    echo "❌ Fail: Relayer is NOT running. Please run 'start-relayer.sh' first."
    exit 1
fi

# 1. 準備: テスト用ファイルの作成
TEST_FILE="/tmp/test-data-$(date +%s).bin"
echo "--> 📄 Creating dummy file (Random data)..."
dd if=/dev/urandom of=$TEST_FILE bs=1024 count=1 2>/dev/null
kubectl cp $TEST_FILE $NAMESPACE/$GWC_POD:$TEST_FILE

# ログの現在位置（行数）を記録しておく（これ以降のログだけを対象にするため）
START_LINE=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- wc -l < $LOG_FILE || echo "0")
START_LINE=$((START_LINE + 1))

# 2. Upload実行
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

# 3. Relayerログによる完了確認
echo "--> ⏳ Waiting for IBC Packet Delivery (Scanning Relayer logs)..."

MAX_WAIT=30
FOUND_PACKET=false

for ((i=1; i<=MAX_WAIT; i++)); do
    # ログの増分を取得してチェック
    # "MsgRecvPacket" (相手に届いた) または "MsgAcknowledgement" (完了通知が戻った) を探す
    LOG_OUTPUT=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- tail -n +$START_LINE $LOG_FILE 2>/dev/null)
    
    if echo "$LOG_OUTPUT" | grep -q "MsgRecvPacket"; then
        echo "   ✅ Detected: Packet received on target chain ($TARGET_CHAIN)."
        FOUND_PACKET=true
    fi
    
    if echo "$LOG_OUTPUT" | grep -q "MsgAcknowledgement"; then
        echo "   ✅ Detected: Acknowledgement received on GWC."
        echo "🎉 Success: Upload cycle completed via IBC!"
        exit 0
    fi
    
    echo -n "."
    sleep 2
done

echo ""
echo "❌ Timeout: IBC packet delivery not confirmed in logs."
echo "Debug: Recent Relayer Logs:"
kubectl exec -n $NAMESPACE $RELAYER_POD -- tail -n 10 $LOG_FILE
exit 1