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
    if kubectl exec -n $NAMESPACE $RELAYER_POD -- pgrep -f "rly start" > /dev/null; then
        echo "✅ Relayer Process: Active (Running)"
    else
        echo "❌ Relayer Process: INACTIVE (Run 'just start-system')"
    fi
fi
echo ""

# 2. Treasury Status (GWC)
echo "[2. Treasury (GWC)]"
GWC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}" 2>/dev/null)
if [ -n "$GWC_POD" ]; then
    MILLIONAIRE_ADDR=$(kubectl exec -n $NAMESPACE $GWC_POD -- gwcd keys show millionaire -a --keyring-backend test --home /home/gwc/.gwc 2>/dev/null)
    BALANCE=$(kubectl exec -n $NAMESPACE $GWC_POD -- gwcd q bank balances $MILLIONAIRE_ADDR -o json 2>/dev/null | jq -r '.balances[] | select(.denom=="uatom") | .amount')
    
    if [ -n "$BALANCE" ]; then
        echo "💰 Millionaire Balance: $(($BALANCE / 1000000)) ATOM ($BALANCE uatom)"
    else
        echo "❌ Could not fetch balance."
    fi
else
    echo "❌ GWC Pod not found."
fi
echo ""

# 3. Chain Liveness (Block Height)
echo "[3. Chain Liveness]"
kubectl get pods -n $NAMESPACE -l 'app.kubernetes.io/category=chain' -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/instance}{" "}{.status.podIP}{"\n"}{end}' | while read -r NAME IP; do
    # RPC status query via curl (timeout 2s)
    # Note: Using localhost port-forward logic or jumping via another pod is needed if not accessible directly.
    # Here we assume we run this inside the cluster or via kubectl exec.
    # We use kubectl exec to curl localhost inside the pod.
    
    HEIGHT=$(kubectl exec -n $NAMESPACE "${NAMESPACE}-${NAME}-0" -- curl -s http://localhost:26657/status | jq -r '.result.sync_info.latest_block_height' 2>/dev/null)
    
    if [ -n "$HEIGHT" ] && [ "$HEIGHT" != "null" ]; then
        echo "✅ $NAME: Height $HEIGHT"
    else
        echo "❌ $NAME: Not Responding"
    fi
done
echo ""

echo "=== End of Report ==="