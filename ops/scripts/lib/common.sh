#!/bin/bash

# =============================================================================
# 🛠️ Configuration & Constants
# =============================================================================
export NAMESPACE=${NAMESPACE:-"cryptomeria"}
export RELEASE_NAME=${RELEASE_NAME:-"cryptomeria"}
export HEADLESS_SERVICE="cryptomeria-chain-headless"
export DENOM="uatom"
export RELAYER_KEY="relayer"
export MILLIONAIRE_KEY="local-admin" # 資金源

# =============================================================================
# 📝 Logging Functions
# =============================================================================
log_info() { echo "INFO: $1"; }
log_step() { echo "--> $1"; }
log_success() { echo "✅ $1"; }
log_warn() { echo "⚠️  $1"; }
log_error() { echo "❌ $1"; exit 1; }

# =============================================================================
# 🐳 Kubernetes Helper Functions
# =============================================================================

# Helper: Wait for Pod Creation (Pod名が確定するまで待つ)
wait_for_pod_name() {
    local label=$1
    local ns="cryptomeria"
    
    echo -n "🔍 Waiting for pod creation (app=$label)... " >&2
    for i in {1..30}; do
        # 2>/dev/null でエラーを隠しつつ取得試行
        local name=$(kubectl get pods -n $ns -l app=$label -o jsonpath="{.items[0].metadata.name}" 2>/dev/null)
        
        if [ -n "$name" ]; then
            echo "✅ Found: $name" >&2
            echo "$name"
            return 0
        fi
        echo -n "." >&2
        sleep 2
    done
    
    echo "❌ Timeout waiting for pod creation." >&2
    exit 1
}

# Relayer Podを特定 (シングルトン)
ensure_relayer_pod() {
    if [ -z "$RELAYER_POD" ]; then
        RELAYER_POD=$(wait_for_pod_name "relayer")
        if [ -z "$RELAYER_POD" ]; then
            log_error "Relayer pod not found in namespace '$NAMESPACE'."
        fi
    fi
}

# チェーンIDからPod名を特定
# Usage: get_chain_pod_name "gwc" -> "cryptomeria-gwc-0"
get_chain_pod_name() {
    local chain_id=$1
    if [ "$chain_id" == "gwc" ]; then
        kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}"
    else
        echo "${RELEASE_NAME}-${chain_id}-0"
    fi
}

# チェーンIDからバイナリ名を特定
# Usage: get_chain_bin_name "fdsc-0" -> "fdscd"
get_chain_bin_name() {
    local chain_id=$1
    if [ "$chain_id" == "gwc" ]; then
        echo "gwcd"
    else
        # fdsc-0 -> fdsc -> fdscd
        echo "${chain_id%-[0-9]*}d"
    fi
}

# =============================================================================
# 🚀 Execution Wrapper Functions
# =============================================================================

# リレイヤーコマンド実行ラッパー
rly_exec() {
    ensure_relayer_pod
    kubectl exec -n "$NAMESPACE" "$RELAYER_POD" -- rly "$@"
}

# 任意のPodでのコマンド実行ラッパー
pod_exec() {
    local pod=$1
    shift
    kubectl exec -n "$NAMESPACE" "$pod" -- "$@"
}