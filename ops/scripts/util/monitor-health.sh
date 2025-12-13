#!/bin/bash
NAMESPACE=${NAMESPACE:-"cryptomeria"}

echo "=== 🏥 Cryptomeria System Health Report ==="
echo "Date: $(date)"
echo ""

# 1. Infrastructure Status
echo "[1. Infrastructure]"
RELAYER_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}" 2>/dev/null)
if [ -z "$RELAYER_POD" ]; then
    echo "❌ Relayer Pod: NOT FOUND"
else
    RLY_STATUS=$(kubectl get pod -n $NAMESPACE $RELAYER_POD -o jsonpath="{.status.phase}")
    echo "✅ Relayer Pod: $RLY_STATUS ($RELAYER_POD)"
    
    # Process Check
    if kubectl exec -n $NAMESPACE $RELAYER_POD -- sh -c "pgrep -f 'rly start' > /dev/null 2>&1"; then
        echo "✅ Relayer Process: Active (Running)"
    else
        echo "❌ Relayer Process: INACTIVE (Process died or not started)"
        echo "   ℹ️  Check logs: kubectl logs -n $NAMESPACE $RELAYER_POD"
    fi
fi
echo ""

# 2. Treasury Status (GWC)
# ▼▼▼ 修正: local-admin の残高を表示するように変更 ▼▼▼
echo "[2. Treasury (GWC - local-admin)]"
GWC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}" 2>/dev/null)
if [ -n "$GWC_POD" ]; then
    ADMIN_ADDR=$(kubectl exec -n $NAMESPACE $GWC_POD -- gwcd keys show local-admin -a --keyring-backend test --home /home/gwc/.gwc 2>/dev/null)
    BALANCE=$(kubectl exec -n $NAMESPACE $GWC_POD -- gwcd q bank balances $ADMIN_ADDR -o json 2>/dev/null | jq -r '.balances[] | select(.denom=="uatom") | .amount' 2>/dev/null)
    
    if [ -n "$BALANCE" ]; then
        echo "💰 Admin Balance: $(($BALANCE / 1000000)) ATOM ($BALANCE uatom)"
    else
        echo "❌ Could not fetch balance or zero balance."
    fi
else
    echo "❌ GWC Pod not found."
fi
echo ""

# 3. Chain Liveness (Block Height)
echo "[3. Chain Liveness]"
kubectl get pods -n $NAMESPACE -l 'app.kubernetes.io/category=chain' -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/instance}{"\n"}{end}' | sort | uniq | while read -r NAME; do
    if [ -z "$NAME" ]; then continue; fi
    
    POD_NAME="${NAMESPACE}-${NAME}-0"
    HEIGHT=$(kubectl exec -n $NAMESPACE "$POD_NAME" -- curl -s http://localhost:26657/status 2>/dev/null | jq -r '.result.sync_info.latest_block_height' 2>/dev/null)
    
    if [ -n "$HEIGHT" ] && [ "$HEIGHT" != "null" ]; then
        echo "✅ $NAME: Height $HEIGHT"
    else
        echo "❌ $NAME: Not Responding"
    fi
done
echo ""

echo "=== End of Report ==="