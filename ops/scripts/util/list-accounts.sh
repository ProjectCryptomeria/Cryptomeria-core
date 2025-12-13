#!/bin/bash
set -e
source "$(dirname "$0")/../control/lib/common.sh"

echo "=== 💰 System Accounts Overview ==="

# 1. 処理対象のチェーンノードを検出
DETECTED_CHAINS=$(kubectl get pods -n "$NAMESPACE" \
    -l "app.kubernetes.io/category=chain" \
    --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/instance}{"\n"}{end}' | sort | uniq)

if [ -z "$DETECTED_CHAINS" ]; then
    log_warn "No running chain pods found."
    exit 0
fi

# 2. 各チェーンノードを処理
for CHAIN_ID in $DETECTED_CHAINS; do
    POD_NAME="${RELEASE_NAME}-${CHAIN_ID}-0"
    
    if [ "$CHAIN_ID" == "gwc" ]; then
         POD_NAME=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")
    fi

    # バイナリ名 (例: fdsc-0 -> fdscd, gwc -> gwcd)
    BIN_NAME="${CHAIN_ID%-[0-9]*}d"
    
    # アプリ名 (例: fdsc, gwc) -> ホームディレクトリ特定用
    APP_NAME="${BIN_NAME%d}"
    HOME_DIR="/home/${APP_NAME}/.${APP_NAME}"

    echo "================================================================================"
    echo "📦 Node: $POD_NAME"
    echo "--------------------------------------------------------------------------------"
    
    # 3. キーリングからアカウント名とアドレスを取得
    # ★修正: --keyring-backend test と --home を追加
    RAW_KEYS=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -- "$BIN_NAME" keys list --output json --keyring-backend test --home "$HOME_DIR" 2>/dev/null || echo "[]")
    
    # jqでのパース (エラーハンドリング付き)
    ACCOUNTS=$(echo "$RAW_KEYS" | jq -r '.[] | .name + " " + .address' 2>/dev/null || true)

    if [ -z "$ACCOUNTS" ]; then
        echo "No accounts found (or failed to retrieve)."
        # デバッグ用: RAW_KEYSが空でないか確認したい場合はコメントアウトを外す
        # echo "Debug: $RAW_KEYS"
        continue
    fi

    printf "%-20s %-45s %s\n" "ACCOUNT NAME" "ADDRESS" "BALANCE"
    echo "--------------------------------------------------------------------------------"

    while IFS= read -r LINE; do
        NAME=$(echo "$LINE" | awk '{print $1}')
        ADDR=$(echo "$LINE" | awk '{print $2}')

        # 4. 全デノミの残高を取得
        BALANCE_JSON=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -- "$BIN_NAME" q bank balances "$ADDR" -o json 2>/dev/null)
        
        # 残高がない場合
        if [ "$BALANCE_JSON" == "null" ] || [ "$(echo "$BALANCE_JSON" | jq -r '.balances | length')" -eq 0 ]; then
            printf "%-20s %-45s %s\n" "$NAME" "$ADDR" "0 $DENOM"
            continue
        fi

        # 全残高をフォーマットして取得 (NativeもIBCも全て)
        BALANCES_FORMATTED=$(echo "$BALANCE_JSON" | jq -r '.balances[] | "\(.amount) \(.denom)"')

        # 最初の残高 (一行目)
        FIRST_BALANCE=$(echo "$BALANCES_FORMATTED" | head -n 1)
        printf "%-20s %-45s %s\n" "$NAME" "$ADDR" "$FIRST_BALANCE"

        # 2番目以降の残高はインデントして表示
        echo "$BALANCES_FORMATTED" | tail -n +2 | while IFS= read -r EXTRA_BALANCE; do
            printf "%-20s %-45s %s\n" "" "" "$EXTRA_BALANCE"
        done

    done <<< "$ACCOUNTS"
    echo
done

echo "================================================================================"