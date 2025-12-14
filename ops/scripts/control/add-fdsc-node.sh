#!/bin/bash
set -e
source "$(dirname "$0")/../lib/common.sh"

# =============================================================================
# 🧩 Functions
# =============================================================================

get_next_replica_info() {
    CURRENT_REPLICAS=$(kubectl get statefulset -n "$NAMESPACE" "${RELEASE_NAME}-fdsc" -o jsonpath='{.spec.replicas}')
    NEW_REPLICAS=$((CURRENT_REPLICAS + 1))
    NEW_INDEX=$((CURRENT_REPLICAS))
    NEW_CHAIN_ID="fdsc-${NEW_INDEX}"
    
    log_info "Current Replicas: $CURRENT_REPLICAS"
    log_info "Target Replicas:  $NEW_REPLICAS (New Node: $NEW_CHAIN_ID)"
}

scale_out() {
    log_step "Scaling StatefulSet to $NEW_REPLICAS..."
    kubectl scale statefulset -n "$NAMESPACE" "${RELEASE_NAME}-fdsc" --replicas="$NEW_REPLICAS"
}

wait_for_pod() {
    log_step "Waiting for $NEW_CHAIN_ID pod to be ready..."
    local new_pod_name="${RELEASE_NAME}-${NEW_CHAIN_ID}-0"
    kubectl wait pod -n "$NAMESPACE" "$new_pod_name" --for=condition=ready --timeout=300s
    log_success "Pod $new_pod_name is Running!"
}

# =============================================================================
# 🚀 Main Execution
# =============================================================================
echo "=== 📈 Scaling Out FDSC Cluster ==="

get_next_replica_info
scale_out
wait_for_pod

# 設定更新と接続 (既存スクリプト再利用)
log_step "Updating Relayer Configuration..."
"$(dirname "$0")/init-relayer.sh"

log_step "Connecting $NEW_CHAIN_ID to GWC..."
"$(dirname "$0")/connect-chain.sh" "$NEW_CHAIN_ID"

log_success "🚀 Successfully added and connected node: $NEW_CHAIN_ID"