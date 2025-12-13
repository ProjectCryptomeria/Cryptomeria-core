#!/bin/bash
set -e

NAMESPACE=${NAMESPACE:-"cryptomeria"}

echo "=== Starting Relayer Process (Background) ==="

# 1. Pod特定
RELAYER_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")
if [ -z "$RELAYER_POD" ]; then
    echo "❌ Error: Relayer pod not found."
    exit 1
fi

# 2. 既に起動しているか確認
if kubectl exec -n $NAMESPACE $RELAYER_POD -- pgrep -f "rly start" > /dev/null; then
    echo "⚠️  Relayer is already running."
    exit 0
fi

# 3. バックグラウンドで起動
# nohup を使い、シェルが終了してもプロセスが残るようにする
echo "--> 🚀 Executing 'rly start' in background..."
kubectl exec -n $NAMESPACE $RELAYER_POD -- sh -c "nohup rly start --log-format json > /home/relayer/.relayer/relayer.log 2>&1 &"

# 4. 起動確認
sleep 2
if kubectl exec -n $NAMESPACE $RELAYER_POD -- pgrep -f "rly start" > /dev/null; then
    echo "✅ Relayer started successfully."
    echo "   Logs are being written to /home/relayer/.relayer/relayer.log"
else
    echo "❌ Failed to start relayer."
    # ログを表示してデバッグ
    kubectl exec -n $NAMESPACE $RELAYER_POD -- cat /home/relayer/.relayer/relayer.log
    exit 1
fi