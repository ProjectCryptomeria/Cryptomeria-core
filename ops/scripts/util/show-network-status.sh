#!/bin/bash
NAMESPACE=${NAMESPACE:-"cryptomeria"}

# 1. 必要なPodを特定
GWC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")
RELAYER_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")

if [ -z "$GWC_POD" ] || [ -z "$RELAYER_POD" ]; then
    echo "Error: Required pods (gwc or relayer) not found."
    exit 1
fi

# 2. GWCの登録済みエンドポイント取得 (Storage Registration Status用)
REGISTERED_JSON=$(kubectl exec -n $NAMESPACE $GWC_POD -- gwcd q gateway endpoints -o json 2>/dev/null || echo "{}")

# 3. GWCのIBCチャネル情報全体を取得 (Channel ID取得用)
# 【修正】jq -s '.' (slurp mode) を使用し、rly q channelsの出力を単一のJSON配列として強制的に結合
RAW_CHANNELS=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- rly q channels gwc 2>/dev/null | jq -s '.' || echo "[]")

# ヘッダー出力: チャンネルIDを2つに分割し、列幅を調整
printf "%-15s %-10s %-12s %-18s %-12s %-12s\n" "CHAIN ID" "TYPE" "POD STATUS" "GW LINK STATUS" "GW CHANNEL" "TF CHANNEL"
echo "--------------------------------------------------------------------------------------"

# 4. 各Podについて情報を表示
kubectl get pods -n $NAMESPACE -l 'app.kubernetes.io/category=chain' -o json | \
jq -r '.items[] | "\(.metadata.labels["app.kubernetes.io/instance"]) \(.metadata.labels["app.kubernetes.io/component"]) \(.status.phase)"' | \
while read -r CHAIN_ID TYPE STATUS; do
    
    # GWC自体の処理
    if [ "$TYPE" == "gwc" ]; then
        printf "%-15s %-10s %-12s %-18s %-12s %-12s\n" "$CHAIN_ID" "$TYPE" "$STATUS" "N/A (Hub)" "-" "-"
        continue
    fi

    # 初期値
    GW_LINK_STATUS="❌ Not Linked"
    GW_CHANNEL="-"
    TF_CHANNEL="-"

    # A. Gateway Channel IDの取得
    # RAW_CHANNELSが単一の配列になったため、.[] の処理が正常化する
    GW_CHANNEL_RAW=$(echo "$RAW_CHANNELS" | jq -r --arg id "$CHAIN_ID" '.[] | select(.port_id=="gateway" and .counterparty.chain_id==$id and .state=="STATE_OPEN") | .channel_id' | head -n 1)
    
    # B. Transfer Channel IDの取得
    TF_CHANNEL_RAW=$(echo "$RAW_CHANNELS" | jq -r --arg id "$CHAIN_ID" '.[] | select(.port_id=="transfer" and .counterparty.chain_id==$id and .state=="STATE_OPEN") | .channel_id' | head -n 1)
    
    # C. ステータスの判定
    if [ "$GW_CHANNEL_RAW" != "null" ] && [ "$GW_CHANNEL_RAW" != "" ]; then
        GW_LINK_STATUS="🔗 Linked"
        GW_CHANNEL="$GW_CHANNEL_RAW"

        # Storage Registration Statusの確認
        ENTRY=$(echo "$REGISTERED_JSON" | jq -r --arg id "$CHAIN_ID" '.storage_infos[] | select(.chain_id == $id)')
        if [ -n "$ENTRY" ]; then
            GW_LINK_STATUS="✅ Registered"
        fi
    fi

    if [ "$TF_CHANNEL_RAW" != "null" ] && [ "$TF_CHANNEL_RAW" != "" ]; then
        TF_CHANNEL="$TF_CHANNEL_RAW"
    fi


    printf "%-15s %-10s %-12s %-18s %-12s %-12s\n" \
        "$CHAIN_ID" \
        "$TYPE" \
        "$STATUS" \
        "$GW_LINK_STATUS" \
        "$GW_CHANNEL" \
        "$TF_CHANNEL"
done