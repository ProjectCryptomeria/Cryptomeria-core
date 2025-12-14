#!/bin/bash
set -e
source "$(dirname "$0")/../lib/common.sh"

KEY_NAME=$1

# =============================================================================
# 🧩 Functions
# =============================================================================

validate_args() {
    if [ -z "$KEY_NAME" ]; then
        echo "Usage: $0 <key-name>"
        exit 1
    fi
}

recover_key() {
    local mnemonic=$1
    local gwc_pod=$(get_chain_pod_name "gwc")
    local home_dir="/home/gwc/.gwc"
    
    log_step "Recovering key..."
    echo "$mnemonic" | kubectl exec -i -n "$NAMESPACE" "$gwc_pod" -- \
        gwcd keys add "$KEY_NAME" --recover --keyring-backend test --home "$home_dir"
}

# =============================================================================
# 🚀 Main Execution
# =============================================================================
validate_args

echo "=== Importing Client Key '$KEY_NAME' to GWC ==="
echo "🔑 Please paste the mnemonic phrase below and press ENTER:"

read -r MNEMONIC
if [ -z "$MNEMONIC" ]; then
    log_error "Mnemonic cannot be empty."
fi

echo ""
recover_key "$MNEMONIC"

log_success "Key '$KEY_NAME' imported successfully!"