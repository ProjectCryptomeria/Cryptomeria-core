#!/bin/bash
set -e
source "$(dirname "$0")/../lib/common.sh"

TARGET_REPLICAS=$1
CHART_PATH="./ops/infra/k8s/helm/cryptomeria"

# =============================================================================
# 🧩 Functions
# =============================================================================

validate_args() {
    if [[ ! "$TARGET_REPLICAS" =~ ^[0-9]+$ ]]; then
        log_error "Usage: $0 <target-replicas> (e.g., 3)"
    fi
}

get_current_replicas() {
    local count=$(kubectl get statefulsets -n "$NAMESPACE" -l "app.kubernetes.io/component=fdsc" --no-headers 2>/dev/null | wc -l)
    echo "$count" | xargs
}

restart_relayer() {
    log_step "Restarting Relayer Pod to load new keys..."
    local relayer_deploy=$(kubectl get deploy -n "$NAMESPACE" -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")
    kubectl rollout restart deployment -n "$NAMESPACE" "$relayer_deploy"
    kubectl rollout status deployment -n "$NAMESPACE" "$relayer_deploy"
}

# =============================================================================
# 🚀 Main Execution
# =============================================================================
validate_args

echo "=== ⚖️ Scaling FDSC Cluster ==="

CURRENT_REPLICAS=$(get_current_replicas)

log_info "Current Replicas: $CURRENT_REPLICAS"
log_info "Target Replicas:  $TARGET_REPLICAS"

if [ "$TARGET_REPLICAS" -eq "$CURRENT_REPLICAS" ]; then
    log_success "Already at target replicas. No changes needed."
    exit 0
fi

# 1. Helm Upgrade (Scale Up/Down)
log_step "Applying Helm Upgrade (replicas=$TARGET_REPLICAS)..."
helm upgrade "$RELEASE_NAME" "$CHART_PATH" \
    --namespace "$NAMESPACE" \
    --reuse-values \
    --set fdsc.replicas="$TARGET_REPLICAS" \
    --wait --timeout 10m

log_success "Helm upgrade complete."

# 2. Scale Out (増える場合)
if [ "$TARGET_REPLICAS" -gt "$CURRENT_REPLICAS" ]; then
    log_step "Scale Out detected. Setting up new nodes..."
    
    START_INDEX=$CURRENT_REPLICAS
    END_INDEX=$((TARGET_REPLICAS - 1))
    
    # A. Pod起動待機
    for ((i=START_INDEX; i<=END_INDEX; i++)); do
        NEW_POD_NAME="${RELEASE_NAME}-fdsc-${i}-0"
        log_step "Waiting for $NEW_POD_NAME to be ready..."
        kubectl wait pod -n "$NAMESPACE" "$NEW_POD_NAME" --for=condition=ready --timeout=300s
    done
    
    # B. Relayer再起動
    restart_relayer
    
    # C. 設定更新
    log_step "Updating Relayer Configuration..."
    "$(dirname "$0")/init-relayer.sh"
    
    # D. IBC接続
    for ((i=START_INDEX; i<=END_INDEX; i++)); do
        NEW_CHAIN_ID="fdsc-$i"
        log_step "Connecting $NEW_CHAIN_ID..."
        "$(dirname "$0")/connect-chain.sh" "$NEW_CHAIN_ID"
    done
    
    # E. プロセス確認
    "$(dirname "$0")/start-relayer.sh"

# 3. Scale In (減る場合) - 削除待機ロジックを追加
elif [ "$TARGET_REPLICAS" -lt "$CURRENT_REPLICAS" ]; then
    log_warn "Scale In detected. Waiting for nodes to be terminated..."
    
    # 削除されるインデックス範囲: Target (例: 1) ～ Current-1 (例: 3-1=2)
    START_INDEX=$TARGET_REPLICAS
    END_INDEX=$((CURRENT_REPLICAS - 1))

    for ((i=START_INDEX; i<=END_INDEX; i++)); do
        POD_NAME="${RELEASE_NAME}-fdsc-${i}-0"
        
        # Podがまだ残っているか確認
        if kubectl get pod -n "$NAMESPACE" "$POD_NAME" >/dev/null 2>&1; then
             log_step "Waiting for termination of $POD_NAME..."
             # 削除完了(NotFoundになる)まで待機
             kubectl wait --for=delete pod -n "$NAMESPACE" "$POD_NAME" --timeout=300s || true
             log_success "$POD_NAME successfully deleted."
        else
             log_info "$POD_NAME is already deleted."
        fi
    done
    
    log_warn "Note: Relayer config for removed nodes remains (harmless)."
fi

log_success "Scale operation complete."