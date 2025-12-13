#!/bin/bash
set -e

NAMESPACE="cryptomeria"
TARGET_CHAIN="fdsc-0"
# StatefulSet/DeploymentからPod名を動的に取得
GWC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")
RELAYER_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")

# common.shと統一した資金源
MILLIONAIRE_KEY="local-admin"
LOG_FILE="/home/relayer/.relayer/relayer.log"

echo "=== Phase 3: E2E Integration Test (Upload & Verify) ==="

# 0. Relayerプロセスの事前確認
echo "--> 🔍 Checking Relayer process..."
if ! kubectl exec -n $NAMESPACE $RELAYER_POD -- sh -c "pgrep -f 'rly start'" > /dev/null; then
    echo "❌ Fail: Relayer is NOT running. Please run 'start-relayer.sh' first."
    exit 1
fi

# 1. ログファイルの存在確認と復旧 (これがないと落ちる)
echo "--> 🛠️  Checking Relayer log file..."
if ! kubectl exec -n $NAMESPACE $RELAYER_POD -- sh -c "[ -f $LOG_FILE ]"; then
    echo "⚠️  Log file not found at $LOG_FILE"
    echo "    Attempting to create empty log file to prevent script crash..."
    if kubectl exec -n $NAMESPACE $RELAYER_POD -- sh -c "touch $LOG_FILE"; then
        echo "    ✅ Created empty log file."
    else
        echo "❌ Critical: Cannot create log file. Check PVC permissions."
        exit 1
    fi
fi

# 2. 準備: テスト用ファイルの作成
TEST_FILE="/tmp/test-data-$(date +%s).bin"
echo "--> 📄 Creating dummy file (Random data)..."
# コンテナ内に直接ファイルを作る
kubectl exec -n $NAMESPACE $GWC_POD -- sh -c "dd if=/dev/urandom of=$TEST_FILE bs=1024 count=1 2>/dev/null"

# ログの現在位置（行数）を記録しておく
# sh -c で囲み、リダイレクトをPod内で評価させる
START_LINE=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- sh -c "wc -l < $LOG_FILE" || echo "0")
START_LINE=$((START_LINE + 1))

# 3. Upload実行
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

# 4. Relayerログによる完了確認
echo "--> ⏳ Waiting for IBC Packet Delivery (Scanning Relayer logs)..."

MAX_WAIT=30
FOUND_PACKET=false

for ((i=1; i<=MAX_WAIT; i++)); do
    # ログの増分を取得してチェック
    # ファイルが空やローテートされていても落ちないように || true をつける
    LOG_OUTPUT=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- sh -c "tail -n +$START_LINE $LOG_FILE 2>/dev/null" || true)
    
    if echo "$LOG_OUTPUT" | grep -q "MsgRecvPacket"; then
        if [ "$FOUND_PACKET" = false ]; then
            echo "   ✅ Detected: Packet received on target chain ($TARGET_CHAIN)."
            FOUND_PACKET=true
        fi
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