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
# LOG_FILEは使用しないため削除
# LOG_FILE="/home/relayer/.relayer/relayer.log" 

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

# 2. ログファイルの存在確認 (削除)
# echo "--> 🛠️ Checking Relayer log file..."
# if ! kubectl exec -n $NAMESPACE $RELAYER_POD -- sh -c "[ -f $LOG_FILE ]"; then
#   echo "❌ Error: Log file ($LOG_FILE) not found."
#   exit 1
# fi

# 3. 準備: テスト用ファイルの作成
TEST_FILE="/tmp/test-data-$(date +%s).bin"
echo "--> 📄 Creating dummy file (Random data)..."
# GWCコンテナ内でファイルを作成
kubectl exec -n $NAMESPACE $GWC_POD -- sh -c "dd if=/dev/urandom of=$TEST_FILE bs=1024 count=1 2>/dev/null"

# ログの現在位置（行数）を記録 (削除)
# START_LINE=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- sh -c "wc -l < $LOG_FILE" || echo "0")
# START_LINE=$((START_LINE + 1))

# 4. Upload実行とRelayerログによる通信確認 (統合)
echo "--> 📤 Submitting Upload Transaction & Waiting for IBC Packet Delivery..."

MAX_WAIT=30
IBC_SUCCESS=false
FOUND_PACKET=false # MsgRecvPacket検出用

# 💡 ログ監視用のパイプと成功通知用のシグナルファイル
SIGNAL_FILE="/tmp/ibc_success_signal_$$"
LOG_PIPE="/tmp/ibc_log_pipe_$$"
LOG_PID=""
MONITOR_PID=""

# 💡 クリーンアップ処理: スクリプト終了時にプロセスと一時ファイルを強制停止/削除
trap "rm -f \"$SIGNAL_FILE\" \"$LOG_PIPE\"; kill $LOG_PID 2>/dev/null || true; kill $MONITOR_PID 2>/dev/null || true" EXIT

# 4-A. ログストリーム監視の開始
if [ -e "$LOG_PIPE" ]; then rm -f "$LOG_PIPE"; fi
if ! mkfifo "$LOG_PIPE"; then
    echo "❌ Error: Failed to create named pipe $LOG_PIPE" >&2
    exit 1
fi

# kubectl logs -f をバックグラウンドで実行し、パイプに流し込む
echo "  ⏳ Starting Relayer log stream..."
# --since=5s で直近のログから開始し、テスト実行前の古いログの巻き込みを防ぐ
kubectl logs -n $NAMESPACE $RELAYER_POD -f --since=5s 2>/dev/null > "$LOG_PIPE" &
LOG_PID=$!

# パイプからの読み込みと信号ファイル生成を別プロセスで実行
(
    # FOUND_PACKET の状態を保持するため、このサブシェル内で処理する
    LOCAL_FOUND_PACKET=false
    while IFS= read -r line; do
        # 取得したログを表示 (色付きでRelayerログであることを明示)
        echo -e "\033[0;90m$line\033[0m" >&2
        
        # 受信パケットを検出 (FOUND_PACKETはここではローカル変数として扱う)
        if [[ "$line" =~ "MsgRecvPacket" ]] && [ "$LOCAL_FOUND_PACKET" = false ]; then
            echo "  ✅ Detected: Packet received on target chain." >&2
            LOCAL_FOUND_PACKET=true
        fi

        # 成功メッセージを検出したら信号ファイルを生成して終了
        if [[ "$line" =~ "MsgAcknowledgement" ]]; then
            echo "  ✅ Detected: Acknowledgement received on GWC." >&2
            touch "$SIGNAL_FILE"
            break
        fi
    done < "$LOG_PIPE"
) &
MONITOR_PID=$!

# 4-B. Upload実行
UPLOAD_CMD="gwcd tx gateway upload $TEST_FILE $TARGET_CHAIN --from $MILLIONAIRE_KEY --chain-id gwc -y --output json --keyring-backend test --home /home/gwc/.gwc"

TX_RES=$(kubectl exec -n $NAMESPACE $GWC_POD -- $UPLOAD_CMD)
TX_HASH=$(echo "$TX_RES" | jq -r '.txhash')

if [ -z "$TX_HASH" ] || [ "$TX_HASH" == "null" ]; then
  echo "❌ Fail: Upload transaction failed." >&2
  echo "$TX_RES" >&2
  exit 1
fi
echo "  TxHash: $TX_HASH"

# 4-C. 成功シグナルを待機
echo "  ⏳ Waiting for IBC Acknowledgement (Max ${MAX_WAIT}s)..."
START_TIME=$(date +%s)
END_TIME=$((START_TIME + MAX_WAIT))

while [ $(date +%s) -lt "$END_TIME" ]; do
    if [ -f "$SIGNAL_FILE" ]; then
        IBC_SUCCESS=true
        break
    fi
    echo -n "."
    sleep 2
done

# ログ監視プロセスを確実に停止
kill $LOG_PID 2>/dev/null || true
kill $MONITOR_PID 2>/dev/null || true
rm -f "$LOG_PIPE" 

if [ "$IBC_SUCCESS" = false ]; then
  echo ""
  echo "❌ Timeout: IBC packet delivery not confirmed in logs."
  # ログファイルに依存しないデバッグ情報を表示
  echo "Debug: Recent Relayer Pod Logs (Last 20 lines):"
    kubectl logs -n $NAMESPACE $RELAYER_POD --tail=20
  exit 1
fi

# trap のリセット
trap - EXIT

# 6. データ永続化の確認 (Verification)
echo "--> 💾 Verifying Data Persistence on Storage Nodes..."

# A. FDSC (Data Fragment) の確認
echo "  🔍 Checking FDSC ($TARGET_CHAIN)..."
FDSC_OK=false
for i in {1..5}; do
  # list-fragment クエリを実行し、結果の配列長を確認
  COUNT=$(kubectl exec -n $NAMESPACE $FDSC_POD -- fdscd q datastore list-fragment -o json | jq '.fragment | length' 2>/dev/null || echo "0")
  if [ "$COUNT" -gt 0 ]; then
    echo "  ✅ FDSC: Data Fragment found! (Total Fragments: $COUNT)"
    FDSC_OK=true
    break
  fi
  sleep 2
done

# B. MDSC (Metadata Manifest) の確認
echo "  🔍 Checking MDSC (Metadata)..."
MDSC_OK=false
for i in {1..5}; do
  # list-manifest クエリを実行
  COUNT=$(kubectl exec -n $NAMESPACE $MDSC_POD -- mdscd q metastore list-manifest -o json | jq '.manifest | length' 2>/dev/null || echo "0")
  if [ "$COUNT" -gt 0 ]; then
    echo "  ✅ MDSC: Metadata Manifest found! (Total Manifests: $COUNT)"
    MDSC_OK=true
    break
  fi
  sleep 2
done

# 最終判定
if [ "$FDSC_OK" = true ] && [ "$MDSC_OK" = true ]; then
  echo "🎉 Success: Full End-to-End Test Passed!"
  echo "  - Upload Tx: OK"
  echo "  - IBC Relay: OK"
  echo "  - Storage Persistence: OK"
  exit 0
else
  echo "❌ Fail: Data verification failed."
  [ "$FDSC_OK" = false ] && echo "  - FDSC missing data."
  [ "$MDSC_OK" = false ] && echo "  - MDSC missing metadata."
  exit 1
fi