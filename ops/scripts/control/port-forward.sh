#!/bin/bash
# Cryptomeria-Bff port-forward script
# devcontainer環境でK8s NodePortサービスにアクセスするためのポートフォワーディング
#
# 使用方法:
#   yarn port-forward    # 全チェーンのport-forwardを開始
#   Ctrl+C              # 終了
#
set -e

NAMESPACE="${K8S_NAMESPACE:-cryptomeria}"

echo "🔌 Starting port-forward for Cryptomeria chains..."
echo "   Namespace: ${NAMESPACE}"
echo ""

# 既存のport-forwardプロセスをクリーンアップ
cleanup() {
    echo ""
    echo "🛑 Stopping port-forward..."
    pkill -P $$ 2>/dev/null || true
    wait 2>/dev/null || true
    echo "✅ Port-forward stopped."
}
trap cleanup EXIT INT TERM

# チェーンごとのポートフォワード設定
# 形式: サービス名:ローカルポート:ターゲットポート
FORWARDS=(
    # gwc chain
    "cryptomeria-gwc:1317:1317"   # REST API
    "cryptomeria-gwc:26657:26657"  # RPC
    "cryptomeria-gwc:9090:9090"   # gRPC
    
    # fdsc-chain
    "cryptomeria-fdsc:1317:1317"
    "cryptomeria-fdsc:26657:26657"
    "cryptomeria-fdsc:9090:9090"
    
    # mdsc chain
    "cryptomeria-mdsc:1317:1317"
    "cryptomeria-mdsc:26657:26657"
    "cryptomeria-mdsc:9090:9090"
)

PIDS=()

for forward in "${FORWARDS[@]}"; do
    IFS=':' read -r service local_port target_port <<< "$forward"
    
    # 【修正】Service名からPod名を推測するロジックを追加
    # StatefulSetの場合、通常は "サービス名-0" となる (例: cryptomeria-gwc-0)
    # もしDeploymentでランダムなハッシュがつく場合は、kubectl get pods で動的に取得する必要があるが、
    # 今回の構成(StatefulSet)であればこれで固定できるはずです。
    
    POD_NAME="${service}-0" 

    echo "  → ${service} (pod/${POD_NAME}): localhost:${local_port} → ${target_port}"
    
    # "svc/${service}" を "pod/${POD_NAME}" に変更
    kubectl port-forward -n "${NAMESPACE}" "pod/${POD_NAME}" "${local_port}:${target_port}" &>/dev/null &
    PIDS+=($!)
done

echo ""
echo "✅ Port-forward started for ${#FORWARDS[@]} ports."
echo ""
echo "📋 Available endpoints:"
echo "   gwc:     REST=http://localhost:30003  RPC=http://localhost:30007"
echo "   fdsc-0:  REST=http://localhost:30023  RPC=http://localhost:30027"
echo "   mdsc:    REST=http://localhost:30013  RPC=http://localhost:30017"
echo ""
echo "Press Ctrl+C to stop."
echo ""

# 全てのバックグラウンドプロセスを待機
wait
