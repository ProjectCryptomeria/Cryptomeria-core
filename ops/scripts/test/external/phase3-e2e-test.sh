#!/bin/bash
set -e

NAMESPACE="cryptomeria"

# 各Podの特定
GWC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")
RELAYER_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")
MDSC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=mdsc" -o jsonpath="{.items[0].metadata.name}")

MILLIONAIRE_KEY="local-admin"
# LOG_FILEは使用しないため削除
# LOG_FILE="/home/relayer/.relayer/relayer.log" 

echo "=== Phase 3: E2E Integration Test (Upload & Verify) ==="

# 0. Pod検出確認
if [ -z "$MDSC_POD" ]; then
  echo "❌ Error: Target pod (MDSC) not found."
  exit 1
fi

# 1. Relayerプロセスの事前確認
echo "--> 🔍 Checking Relayer process..."
if ! kubectl exec -n $NAMESPACE $RELAYER_POD -- sh -c "pgrep -f 'rly start'" > /dev/null; then
  echo "❌ Fail: Relayer is NOT running. Please run 'just start-system' first."
  exit 1
fi

# 3. 準備: テスト用ファイルの作成
TEST_FILE="/tmp/test-data-$(date +%s).bin"
echo "--> 📄 Creating dummy file (Random data)..."
# GWCコンテナ内でファイルを作成
kubectl exec -n $NAMESPACE $GWC_POD -- sh -c "dd if=/dev/urandom of=$TEST_FILE bs=1024 count=1 2>/dev/null"

# 今回のテスト用プロジェクト名（必ず安全な文字で生成）
PROJECT_NAME="e2e-$(date +%s)"
UPLOAD_NAME="dummy.bin"

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
# IMPORTANT: CmdUpload の第2引数は「送信するデータ」です。
# '@<path>' 形式でファイルを読み込ませる。
UPLOAD_CMD="gwcd tx gateway upload $UPLOAD_NAME @$TEST_FILE --project-name $PROJECT_NAME --version v1 --from $MILLIONAIRE_KEY --chain-id gwc -y --output json --keyring-backend test --home /home/gwc/.gwc"

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

# A. MDSC: このテストで作成したプロジェクトの manifest が存在するか
echo "  🔍 Checking MDSC for project manifest..."
MDSC_OK=false
MANIFEST_JSON=""
for i in {1..15}; do
  if MANIFEST_JSON=$(kubectl exec -n $NAMESPACE $MDSC_POD -- mdscd q metastore show-manifest "$PROJECT_NAME" -o json 2>/dev/null); then
    MDSC_OK=true
    break
  fi
  sleep 2
done

if [ "$MDSC_OK" = true ]; then
  echo "  ✅ MDSC: Manifest found for project '$PROJECT_NAME'"
else
  echo "❌ Fail: Manifest not found for project '$PROJECT_NAME'"
  echo "Debug: Recent MDSC Pod Logs (Last 50 lines):"
  kubectl logs -n $NAMESPACE $MDSC_POD --tail=50
  exit 1
fi

# B. FDSC: manifest に含まれる fragment を、正しいチェーンで取得できるか
echo "  🔍 Checking FDSC for at least one fragment referenced by manifest..."
FDSC_OK=false

# manifest から fragment と fdsc_id(channel_id) を抽出
FDSC_CHANNEL=$(echo "$MANIFEST_JSON" | jq -r --arg FN "$UPLOAD_NAME" '.manifest.files[$FN].fragments[0].fdsc_id')
FRAGMENT_ID=$(echo "$MANIFEST_JSON" | jq -r --arg FN "$UPLOAD_NAME" '.manifest.files[$FN].fragments[0].fragment_id')

if [ -z "$FDSC_CHANNEL" ] || [ "$FDSC_CHANNEL" = "null" ] || [ -z "$FRAGMENT_ID" ] || [ "$FRAGMENT_ID" = "null" ]; then
  echo "❌ Fail: Could not extract fragment mapping from manifest."
  echo "$MANIFEST_JSON" | jq '.'
  exit 1
fi

# GWC の endpoints から channel_id -> chain_id を解決
ENDPOINTS_JSON=$(kubectl exec -n $NAMESPACE $GWC_POD -- gwcd q gateway endpoints -o json 2>/dev/null || echo "")
FDSC_CHAIN_ID=$(echo "$ENDPOINTS_JSON" | jq -r --arg CH "$FDSC_CHANNEL" '.storage_infos[] | select(.channel_id==$CH) | .chain_id' | head -n 1)

if [ -z "$FDSC_CHAIN_ID" ] || [ "$FDSC_CHAIN_ID" = "null" ]; then
  echo "❌ Fail: Could not resolve fdsc chain id for channel '$FDSC_CHANNEL' from gwc endpoints."
  echo "$ENDPOINTS_JSON" | jq '.'
  exit 1
fi

FDSC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/instance=$FDSC_CHAIN_ID" -o jsonpath="{.items[0].metadata.name}")
if [ -z "$FDSC_POD" ]; then
  echo "❌ Fail: FDSC pod not found for chain '$FDSC_CHAIN_ID'"
  exit 1
fi

FRAG_JSON=$(kubectl exec -n $NAMESPACE $FDSC_POD -- fdscd q datastore get-fragment "$FRAGMENT_ID" -o json 2>/dev/null || echo "")
DATA_B64=$(echo "$FRAG_JSON" | jq -r '.fragment.data' 2>/dev/null || echo "null")

if [ -n "$DATA_B64" ] && [ "$DATA_B64" != "null" ]; then
  echo "  ✅ FDSC: Fragment retrievable (chain=$FDSC_CHAIN_ID pod=$FDSC_POD fragment_id=$FRAGMENT_ID)"
  FDSC_OK=true
else
  echo "❌ Fail: Fragment not retrievable from resolved FDSC."
  echo "Resolved: channel=$FDSC_CHANNEL chain=$FDSC_CHAIN_ID pod=$FDSC_POD fragment_id=$FRAGMENT_ID"
  echo "$FRAG_JSON" | jq '.' || true
fi

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
