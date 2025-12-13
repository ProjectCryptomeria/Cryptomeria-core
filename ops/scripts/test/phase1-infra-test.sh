#!/bin/bash
set -e

NAMESPACE="cryptomeria"
MILLIONAIRE_MNEMONIC="verify sustain lumber boat ram change pupil happy index barely very fat clip bottom choose neglect hidden barely cheese canal drop cook obscure pottery"

# --- Helper Functions ---
wait_for_pod() {
    local component=$1
    echo "--> ⏳ Waiting for $component pod to be ready..."
    
    # 最大60回(60秒)トライ
    for i in {1..60}; do
        # Pod名を取得 (ラベルを修正: gateway -> gwc)
        POD_NAME=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=$component" -o jsonpath="{.items[0].metadata.name}" 2>/dev/null || echo "")
        
        if [ -n "$POD_NAME" ]; then
            # Podが見つかったら、Runningかどうかチェック
            STATUS=$(kubectl get pod -n $NAMESPACE "$POD_NAME" -o jsonpath="{.status.phase}")
            if [ "$STATUS" == "Running" ]; then
                echo "   ✅ Found running pod: $POD_NAME"
                return 0
            fi
        fi
        sleep 2
        echo -n "."
    done
    
    echo ""
    echo "❌ Timeout waiting for $component pod."
    return 1
}

echo "=== Phase 1: Infrastructure State Verification Test ==="

# 1. リレイヤーのPod特定とチェック
if wait_for_pod "relayer"; then
    RELAYER_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")
    
    echo "--> Checking Relayer Configuration..."
    if kubectl exec -n $NAMESPACE $RELAYER_POD -- rly config show > /dev/null 2>&1; then
        CONFIG_CONTENT=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- rly config show 2>/dev/null)
        if echo "$CONFIG_CONTENT" | grep -q "chain-id"; then
            echo "❌ Fail: Relayer is already configured (Auto-pilot active)."
        else
            echo "✅ Pass: Relayer config is present but empty (Standby mode)."
        fi
    else
        echo "✅ Pass: Relayer is unconfigured (Standby mode)."
    fi

    echo "--> Checking PVC Persistence..."
    TEST_FILE="/home/relayer/.relayer/persistence_test_$(date +%s)"
    if kubectl exec -n $NAMESPACE $RELAYER_POD -- df -h /home/relayer/.relayer | grep -q "/dev/"; then
        echo "✅ Pass: /home/relayer/.relayer is mounted (PVC attached)."
        kubectl exec -n $NAMESPACE $RELAYER_POD -- touch "$TEST_FILE"
    else
        echo "❌ Fail: /home/relayer/.relayer is NOT mounted as a separate volume."
    fi
else
    echo "❌ Skip: Relayer pod not found."
    exit 1
fi

# 2. GWCのPod特定とチェック (ラベル修正: gateway -> gwc)
if wait_for_pod "gwc"; then
    GWC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")
    
    echo "--> Checking Millionaire Genesis Account..."
    # ホームディレクトリの修正: /home/gateway/.gateway -> /home/gwc/.gwc
    if kubectl exec -n $NAMESPACE $GWC_POD -- gwcd keys show millionaire --keyring-backend test --home /home/gwc/.gwc > /dev/null 2>&1; then
        ADDR=$(kubectl exec -n $NAMESPACE $GWC_POD -- gwcd keys show millionaire -a --keyring-backend test --home /home/gwc/.gwc)
        BALANCE=$(kubectl exec -n $NAMESPACE $GWC_POD -- gwcd q bank balances $ADDR -o json | jq -r '.balances[] | select(.denom=="uatom") | .amount')
        
        # 期待値: 1000億
        EXPECTED="100000000000"
        if [ "$BALANCE" == "$EXPECTED" ]; then
            echo "✅ Pass: Millionaire account $ADDR has 100,000,000,000 uatom."
        else
            echo "❌ Fail: Millionaire account balance is $BALANCE (Expected: $EXPECTED)."
        fi
    else
        echo "❌ Fail: Key 'millionaire' not found in GWC keyring."
    fi
else
    echo "❌ Skip: GWC pod not found or not running."
    exit 1
fi

echo "=== Test Complete ==="