#!/bin/bash

# =============================================================================
# 🛠️ Configuration & Constants
# =============================================================================
export NAMESPACE=${NAMESPACE:-"cryptomeria"}
export RELEASE_NAME=${RELEASE_NAME:-"cryptomeria"}
export HEADLESS_SERVICE="cryptomeria-chain-headless"
export DENOM="uatom"
export RELAYER_KEY="relayer"  # 共通鍵名
export MILLIONAIRE_KEY="millionaire"

# =============================================================================
# 📝 Logging Helper
# =============================================================================
log_info() { echo "INFO: $1"; }
log_step() { echo "--> $1"; }
log_success() { echo "✅ $1"; }
log_warn() { echo "⚠️  $1"; }
log_error() { echo "❌ $1"; exit 1; }

# =============================================================================
# 🐳 Kubernetes & Relayer Helpers
# =============================================================================

# Relayer Podを特定して変数にセット (シングルトン的挙動)
ensure_relayer_pod() {
    if [ -z "$RELAYER_POD" ]; then
        RELAYER_POD=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")
        if [ -z "$RELAYER_POD" ]; then
            log_error "Relayer pod not found in namespace '$NAMESPACE'."
        fi
    fi
}

# リレイヤーコマンド実行ラッパー (DRY)
# 使用例: rly_exec keys list
rly_exec() {
    ensure_relayer_pod
    kubectl exec -n "$NAMESPACE" "$RELAYER_POD" -- rly "$@"
}

# コンテナ内でのコマンド実行ラッパー
# 使用例: pod_exec my-pod-0 ls -la
pod_exec() {
    local pod=$1
    shift
    kubectl exec -n "$NAMESPACE" "$pod" -- "$@"
}