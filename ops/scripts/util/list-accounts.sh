#!/bin/bash
set -e
source "$(dirname "$0")/../lib/common.sh"

# =============================================================================
# 🧩 Functions
# =============================================================================

fetch_accounts() {
    local pod_name=$1
    local bin_name=$2
    local home_dir=$3
    
    kubectl exec -n "$NAMESPACE" "$pod_name" -- "$bin_name" keys list --output json --keyring-backend test --home "$home_dir" 2>/dev/null || echo "[]"
}

get_balance_formatted() {
    local pod_name=$1
    local bin_name=$2
    local address=$3

    local balance_json=$(kubectl exec -n "$NAMESPACE" "$pod_name" -- "$bin_name" q bank balances "$address" -o json 2>/dev/null)
    
    if [ "$balance_json" == "null" ] || [ "$(echo "$balance_json" | jq -r '.balances | length')" -eq 0 ]; then
        echo "0 $DENOM"
    else
        echo "$balance_json" | jq -r '.balances[] | "\(.amount) \(.denom)"'
    fi
}

print_node_accounts() {
    local chain_id=$1
    local pod_name=$(get_chain_pod_name "$chain_id")
    local bin_name=$(get_chain_bin_name "$chain_id")
    local home_dir="/home/${bin_name%d}/.${bin_name%d}"

    echo "================================================================================"
    echo "📦 Node: $pod_name"
    echo "--------------------------------------------------------------------------------"
    
    local raw_keys=$(fetch_accounts "$pod_name" "$bin_name" "$home_dir")
    local accounts=$(echo "$raw_keys" | jq -r '.[] | .name + " " + .address' 2>/dev/null || true)

    if [ -z "$accounts" ]; then echo "No accounts found."; return; fi

    printf "%-20s %-45s %s\n" "ACCOUNT NAME" "ADDRESS" "BALANCE"
    echo "--------------------------------------------------------------------------------"

    while IFS= read -r line; do
        local name=$(echo "$line" | awk '{print $1}')
        local addr=$(echo "$line" | awk '{print $2}')
        local balances=$(get_balance_formatted "$pod_name" "$bin_name" "$addr")

        # 最初の残高
        local first_balance=$(echo "$balances" | head -n 1)
        printf "%-20s %-45s %s\n" "$name" "$addr" "$first_balance"

        # 2番目以降の残高
        echo "$balances" | tail -n +2 | while IFS= read -r extra; do
            printf "%-20s %-45s %s\n" "" "" "$extra"
        done
    done <<< "$accounts"
    echo
}

# =============================================================================
# 🚀 Main Execution
# =============================================================================
echo "=== 💰 System Accounts Overview ==="

DETECTED_CHAINS=$(kubectl get pods -n "$NAMESPACE" \
    -l "app.kubernetes.io/category=chain" \
    --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/instance}{"\n"}{end}' | sort | uniq)

if [ -z "$DETECTED_CHAINS" ]; then
    log_warn "No running chain pods found."
    exit 0
fi

for CHAIN_ID in $DETECTED_CHAINS; do
    print_node_accounts "$CHAIN_ID"
done
echo "================================================================================"