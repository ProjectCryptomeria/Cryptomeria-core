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
    pkill -f "kubectl port-forward" 2>/dev/null || true
    pkill -P $$ 2>/dev/null || true
    wait 2>/dev/null || true
    echo "✅ Port-forward stopped."
}
trap cleanup EXIT INT TERM

# チェーンごとのポートフォワード設定
# 形式: サービス名:ローカルポート:ターゲットポート
FORWARDS=(
    # gwc chain (3000x系)
    "cryptomeria-gwc:30003:1317"    # Local 30003 -> GWC 1317
    "cryptomeria-gwc:30007:26657"   # Local 30007 -> GWC 26657
    "cryptomeria-gwc:30000:9090"    # Local 30000 -> GWC 9090
    
    # fdsc-chain (3002x系)
    "cryptomeria-fdsc:30023:1317"   # Local 30023 -> FDSC 1317
    "cryptomeria-fdsc:30027:26657"  # Local 30027 -> FDSC 26657
    "cryptomeria-fdsc:30020:9090"   # Local 30020 -> FDSC 9090
    
    # mdsc chain (3001x系)
    "cryptomeria-mdsc:30013:1317"   # Local 30013 -> MDSC 1317
    "cryptomeria-mdsc:30017:26657"  # Local 30017 -> MDSC 26657
    "cryptomeria-mdsc:30010:9090"   # Local 30010 -> MDSC 9090
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
