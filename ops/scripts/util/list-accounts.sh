#!/bin/bash
NAMESPACE=${NAMESPACE:-"cryptomeria"}
DENOM="uatom"

echo "=== 💰 System Accounts Overview ==="

# 1. 全チェーンPodの取得 (category=chainラベルが付いているもの)
PODS=$(kubectl get pods -n $NAMESPACE -l 'app.kubernetes.io/category=chain' --field-selector=status.phase=Running -o json)

# 2. 各Podごとにループ処理
echo "$PODS" | jq -r '.items[] | "\(.metadata.name) \(.metadata.labels["app.kubernetes.io/component"])"' | sort | while read -r POD_NAME COMPONENT; do
    
    # セグメントヘッダー
    echo "================================================================================"
    echo "📦 Node: $POD_NAME"
    echo "--------------------------------------------------------------------------------"
    printf "%-20s %-48s %-15s\n" "ACCOUNT NAME" "ADDRESS" "BALANCE"
    echo "--------------------------------------------------------------------------------"

    # バイナリ名とホームディレクトリの設定
    # (基本的に component名 + 'd' がバイナリ名、ホームは /home/component/.component)
    BIN_NAME="${COMPONENT}d"
    HOME_DIR="/home/${COMPONENT}/.${COMPONENT}"

    # キーリストの取得 (JSON形式)
    KEYS_JSON=$(kubectl exec -n $NAMESPACE $POD_NAME -- $BIN_NAME keys list --output json --keyring-backend test --home $HOME_DIR 2>/dev/null)

    if [ -z "$KEYS_JSON" ] || [ "$KEYS_JSON" == "[]" ]; then
        echo "   (No accounts found)"
        echo ""
        continue
    fi

    # 各キーについて残高を問い合わせて表示
    echo "$KEYS_JSON" | jq -r '.[] | "\(.name) \(.address)"' | while read -r KEY_NAME KEY_ADDR; do
        
        # 残高取得
        # エラー抑止(2>/dev/null)を入れているのは、まだチェーンが起動しきっていない場合などを考慮
        BALANCE_RAW=$(kubectl exec -n $NAMESPACE $POD_NAME -- $BIN_NAME q bank balances $KEY_ADDR --output json 2>/dev/null)
        
        # 指定したDENOMのamountを抽出
        AMOUNT=$(echo "$BALANCE_RAW" | jq -r --arg denom "$DENOM" '.balances[] | select(.denom==$denom) | .amount')
        
        # nullなら0にする
        if [ -z "$AMOUNT" ] || [ "$AMOUNT" == "null" ]; then AMOUNT="0"; fi

        printf "%-20s %-48s %-15s\n" "$KEY_NAME" "$KEY_ADDR" "$AMOUNT $DENOM"
    done
    echo ""
done