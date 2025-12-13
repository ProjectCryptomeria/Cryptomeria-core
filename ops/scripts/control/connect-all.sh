#!/bin/bash
set -e
NAMESPACE=${NAMESPACE:-"cryptomeria"}

echo "=== Auto-Connecting All Chains ==="

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
    # fdscの場合は fdsc-0, fdsc-1... と展開する必要があるが、
    # 現状のStatefulSetの命名規則では component=fdsc で統一されている場合、
    # 個別のPod名からチェーンID（fdsc-0, fdsc-1...）を特定する必要がある。
    
    # Pod名からチェーンID（インスタンス名）を取得
    # ラベル app.kubernetes.io/instance を使用
    INSTANCES=$(kubectl get pods -n $NAMESPACE -l "app.kubernetes.io/component=$CHAIN" -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/instance}{"\n"}{end}')
    
    for ID in $INSTANCES; do
        echo "------------------------------------------------"
        echo "🚀 Connecting chain: $ID"
        "$SCRIPT_DIR/connect-chain.sh" "$ID"
    done
done

echo "=== All connections processed ==="