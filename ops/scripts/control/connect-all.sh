#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

echo "=== Auto-Connecting All Chains ==="

# 1. ターゲットChainの自動検出
# (gwc, relayer以外のPodの component ラベルを取得)
TARGETS=$(kubectl get pods -n "$NAMESPACE" -l 'app.kubernetes.io/component!=gwc,app.kubernetes.io/component!=relayer' --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/component}{"\n"}{end}' | sort | uniq)

if [ -z "$TARGETS" ]; then
    log_warn "No target chains found."
    exit 0
fi

# 2. 各コンポーネントのインスタンスごとに実行
SCRIPT_DIR=$(dirname "$0")

for COMPONENT in $TARGETS; do
    # StatefulSetインスタンス名 (例: fdsc-0, fdsc-1) を取得
    INSTANCES=$(kubectl get pods -n "$NAMESPACE" -l "app.kubernetes.io/component=$COMPONENT" -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/instance}{"\n"}{end}')
    
    for CHAIN_ID in $INSTANCES; do
        log_step "Triggering connection for: $CHAIN_ID"
        "$SCRIPT_DIR/connect-chain.sh" "$CHAIN_ID"
    done
done

log_success "All connections processed."