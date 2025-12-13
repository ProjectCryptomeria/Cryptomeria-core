#!/bin/bash
set -e
NAMESPACE=${NAMESPACE:-"cryptomeria"}

echo "=== Auto-Connecting All Chains (Sequential) ==="

# 1. GWC以外のチェーンPod（Running状態）をリストアップ
# ラベル component が gwc, relayer 以外のものを抽出
PODS=$(kubectl get pods -n $NAMESPACE -l 'app.kubernetes.io/component!=gwc,app.kubernetes.io/component!=relayer' --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/component}{"\n"}{end}' | sort | uniq)

if [ -z "$PODS" ]; then
    echo "⚠️  No target chains found."
    exit 0
fi

# 2. 各チェーンに対して connect-chain.sh を実行
SCRIPT_DIR=$(dirname "$0")
for CHAIN in $PODS; do
    # Pod名からチェーンID（インスタンス名）を取得
    INSTANCES=$(kubectl get pods -n $NAMESPACE -l "app.kubernetes.io/component=$CHAIN" -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/instance}{"\n"}{end}')
    
    for ID in $INSTANCES; do
        echo "------------------------------------------------"
        echo "🚀 Connecting chain: $ID"
        # 並列化(&)せず、直列実行する
        "$SCRIPT_DIR/connect-chain.sh" "$ID"
    done
done

echo "=== All connections processed ==="