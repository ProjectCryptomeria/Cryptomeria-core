#!/bin/bash
NAMESPACE=${NAMESPACE:-"cryptomeria"}

# ヘッダー出力
printf "%-15s %-12s %-12s %-20s %-20s\n" "CHAIN ID" "TYPE" "POD STATUS" "IBC STATUS" "CHANNEL ID"
echo "--------------------------------------------------------------------------------------"

# 1. 全チェーンPodの取得
PODS=$(kubectl get pods -n $NAMESPACE -l 'app.kubernetes.io/category=chain' -o json)

# 2. GWCの登録済みエンドポイント取得
GWC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")
REGISTERED_JSON=$(kubectl exec -n $NAMESPACE $GWC_POD -- gwcd q gateway endpoints -o json 2>/dev/null)

# 3. 各Podについて情報を表示
echo "$PODS" | jq -r '.items[] | "\(.metadata.labels["app.kubernetes.io/instance"]) \(.metadata.labels["app.kubernetes.io/component"]) \(.status.phase)"' | while read -r CHAIN_ID TYPE STATUS; do
    
    IBC_STATUS="⚠️ Unconnected"
    CHANNEL_ID="-"

    if [ "$TYPE" == "gwc" ]; then
        IBC_STATUS="N/A (Hub)"
    else
        # 登録済みリストにあるか確認
        # jqで chain_id が一致するものを検索
        ENTRY=$(echo "$REGISTERED_JSON" | jq -r --arg id "$CHAIN_ID" '.storage_infos[] | select(.chain_id == $id)')
        
        if [ -n "$ENTRY" ]; then
            IBC_STATUS="✅ Connected"
            CHANNEL_ID=$(echo "$ENTRY" | jq -r '.channel_id')
        fi
    fi

    printf "%-15s %-12s %-12s %-20s %-20s\n" "$CHAIN_ID" "$TYPE" "$STATUS" "$IBC_STATUS" "$CHANNEL_ID"
done