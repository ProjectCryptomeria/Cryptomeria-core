#!/bin/bash
set -e
source "$(dirname "$0")/../lib/common.sh"

SCRIPT_DIR=$(dirname "$0")

# =============================================================================
# 🧩 Functions
# =============================================================================

detect_targets() {
    # gwc以外のChainコンポーネントをリストアップ
    kubectl get pods -n "$NAMESPACE" -l 'app.kubernetes.io/category=chain' \
        --field-selector=status.phase=Running \
        -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/component}{"\n"}{end}' \
        | sort | uniq | grep -v "gwc"
}

connect_instances() {
    local component=$1
    local instances=$(kubectl get pods -n "$NAMESPACE" -l "app.kubernetes.io/component=$component" -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/instance}{"\n"}{end}')
    
    for chain_id in $instances; do
        log_step "Triggering connection for: $chain_id"
        "$SCRIPT_DIR/connect-chain.sh" "$chain_id" &
    done
    wait
}

# =============================================================================
# 🚀 Main Execution
# =============================================================================
echo "=== Auto-Connecting All Chains ==="

TARGETS=$(detect_targets)

if [ -z "$TARGETS" ]; then
    log_warn "No target chains found."
    exit 0
fi

for COMPONENT in $TARGETS; do
    connect_instances "$COMPONENT"
done

log_success "All connections processed."