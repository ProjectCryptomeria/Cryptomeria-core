#!/bin/bash
set -e
NAMESPACE=${NAMESPACE:-"cryptomeria"}
ADDRESS=$1
AMOUNT=$2

if [ -z "$ADDRESS" ] || [ -z "$AMOUNT" ]; then
    echo "Usage: $0 <address> <amount>"
    echo "Example: $0 cosmos1... 1000000uatom"
    exit 1
fi

GWC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")

echo "--> 💸 Sending $AMOUNT to $ADDRESS from Millionaire..."
kubectl exec -n $NAMESPACE $GWC_POD -- gwcd tx bank send millionaire "$ADDRESS" "$AMOUNT" --chain-id gwc -y --keyring-backend test --home /home/gwc/.gwc