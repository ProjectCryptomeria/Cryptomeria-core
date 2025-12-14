#!/bin/bash
# common.shを利用して設定値を統一
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMMON_LIB="${SCRIPT_DIR}/../lib/common.sh"
if [ -f "$COMMON_LIB" ]; then source "$COMMON_LIB"; else NAMESPACE="cryptomeria"; fi

# =============================================================================
# 🧩 Functions
# =============================================================================

get_gw_channel() {
    local chain_id=$1
    local channels_json=$2 # 全チャネル情報のJSON配列
    
    echo "$channels_json" | jq -r --arg id "$chain_id" \
        '.[] | select(.port_id=="gateway" and .counterparty.chain_id==$id and .state=="STATE_OPEN") | .channel_id' | head -n 1
}

is_registered() {
    local chain_id=$1
    local registered_json=$2
    
    local entry=$(echo "$registered_json" | jq -r --arg id "$chain_id" '.storage_infos[] | select(.chain_id == $id)')
    if [ -n "$entry" ]; then echo "true"; else echo "false"; fi
}

# =============================================================================
# 🚀 Main Execution
# =============================================================================
GWC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")
RELAYER_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")

if [ -z "$GWC_POD" ] || [ -z "$RELAYER_POD" ]; then
    echo "Error: Required pods not found."
    exit 1
fi

REGISTERED_JSON=$(kubectl exec -n $NAMESPACE $GWC_POD -- gwcd q gateway endpoints -o json 2>/dev/null || echo "{}")
RAW_CHANNELS=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- rly q channels gwc 2>/dev/null | jq -s '.' || echo "[]")

printf "%-15s %-10s %-12s %-18s %-12s\n" "CHAIN ID" "TYPE" "POD STATUS" "GW LINK STATUS" "GW CHANNEL"
echo "-----------------------------------------------------------------------"

kubectl get pods -n $NAMESPACE -l 'app.kubernetes.io/category=chain' -o json | \
jq -r '.items[] | "\(.metadata.labels["app.kubernetes.io/instance"]) \(.metadata.labels["app.kubernetes.io/component"]) \(.status.phase)"' | \
while read -r CHAIN_ID TYPE STATUS; do
    
    if [ "$TYPE" == "gwc" ]; then
        printf "%-15s %-10s %-12s %-18s %-12s\n" "$CHAIN_ID" "$TYPE" "$STATUS" "N/A (Hub)" "-"
        continue
    fi

    GW_LINK_STATUS="❌ Not Linked"
    GW_CHANNEL="-"

    GW_CHANNEL_RAW=$(get_gw_channel "$CHAIN_ID" "$RAW_CHANNELS")
    
    if [ "$GW_CHANNEL_RAW" != "null" ] && [ "$GW_CHANNEL_RAW" != "" ]; then
        GW_LINK_STATUS="🔗 Linked"
        GW_CHANNEL="$GW_CHANNEL_RAW"

        if [ "$(is_registered "$CHAIN_ID" "$REGISTERED_JSON")" == "true" ]; then
            GW_LINK_STATUS="✅ Registered"
        fi
    fi

    printf "%-15s %-10s %-12s %-18s %-12s\n" "$CHAIN_ID" "$TYPE" "$STATUS" "$GW_LINK_STATUS" "$GW_CHANNEL"
done