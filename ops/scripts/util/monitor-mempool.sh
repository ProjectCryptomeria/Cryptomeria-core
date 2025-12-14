#!/bin/bash
set -e
source "$(dirname "$0")/../lib/common.sh"

# =============================================================================
# 🧩 Functions
# =============================================================================

get_mempool_size() {
    local pod_name=$1
    local output
    if output=$(kubectl exec -n "$NAMESPACE" "$pod_name" -- sh -c "curl -s http://localhost:26657/num_unconfirmed_txs" 2>/dev/null); then
        echo "$output" | jq -r '.result.total' 2>/dev/null || echo "Err"
    else
        echo "N/A"
    fi
}

# =============================================================================
# 🚀 Main Execution
# =============================================================================
printf "%-20s %-15s %s\n" "CHAIN ID" "STATUS" "MEMPOOL TXs"
echo "----------------------------------------------------"

PODS=$(kubectl get pods -n "$NAMESPACE" -l "app.kubernetes.io/category=chain" --field-selector=status.phase=Running -o json 2>/dev/null)

if [ -z "$PODS" ]; then
    echo "No running chain pods found."
    exit 0
fi

echo "$PODS" | jq -r '.items[] | "\(.metadata.name) \(.metadata.labels["app.kubernetes.io/instance"])"' | \
while read -r POD_NAME CHAIN_ID; do
    TX_COUNT=$(get_mempool_size "$POD_NAME")
    printf "%-20s %-15s %s\n" "$CHAIN_ID" "Running" "$TX_COUNT"
done