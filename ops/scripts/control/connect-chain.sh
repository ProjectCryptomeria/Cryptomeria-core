#!/bin/bash
set -e

# --- 引数 ---
TARGET_CHAIN=$1
if [ -z "$TARGET_CHAIN" ]; then
    echo "Usage: $0 <target-chain-id>"
    exit 1
fi

# --- 設定 ---
NAMESPACE=${NAMESPACE:-"cryptomeria"}
RELEASE_NAME=${RELEASE_NAME:-"cryptomeria"}
HEADLESS_SERVICE="cryptomeria-chain-headless"
DENOM="uatom"
GWC_CHAIN="gwc"
MILLIONAIRE_KEY="millionaire"

echo "=== Connecting Chain: GWC <-> $TARGET_CHAIN ==="

# 1. Pod特定
RELAYER_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")
GWC_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=gwc" -o jsonpath="{.items[0].metadata.name}")
TARGET_POD_NAME="${RELEASE_NAME}-${TARGET_CHAIN}-0"

# 2. 専用鍵の準備
GWC_KEY_NAME="rly-${TARGET_CHAIN}"
TARGET_KEY_NAME="relayer"

echo "--> 🔑 Preparing Keys..."

# --- GWC側の鍵 ---
if ! kubectl exec -n $NAMESPACE $RELAYER_POD -- rly keys show "$GWC_CHAIN" "$GWC_KEY_NAME" >/dev/null 2>&1; then
    echo "   Creating key '$GWC_KEY_NAME' for $GWC_CHAIN..."
    kubectl exec -n $NAMESPACE $RELAYER_POD -- rly keys add "$GWC_CHAIN" "$GWC_KEY_NAME"
else
    echo "   Key '$GWC_KEY_NAME' exists."
fi
GWC_ADDR=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- rly keys show "$GWC_CHAIN" "$GWC_KEY_NAME")

# --- Target側の鍵 ---
if ! kubectl exec -n $NAMESPACE $RELAYER_POD -- rly keys show "$TARGET_CHAIN" "$TARGET_KEY_NAME" >/dev/null 2>&1; then
    echo "   Creating key '$TARGET_KEY_NAME' for $TARGET_CHAIN..."
    kubectl exec -n $NAMESPACE $RELAYER_POD -- rly keys add "$TARGET_CHAIN" "$TARGET_KEY_NAME"
else
    echo "   Key '$TARGET_KEY_NAME' exists."
fi
TARGET_ADDR=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- rly keys show "$TARGET_CHAIN" "$TARGET_KEY_NAME")


# 3. Faucet (資金注入)
echo "--> ⛽ Checking Balance & Faucet..."

# GWC側
BALANCE_GWC=$(kubectl exec -n $NAMESPACE $GWC_POD -- gwcd q bank balances "$GWC_ADDR" -o json | jq -r ".balances[] | select(.denom==\"$DENOM\") | .amount" || echo "0")
if [ -z "$BALANCE_GWC" ]; then BALANCE_GWC=0; fi

if [ "$BALANCE_GWC" -lt "10000000" ]; then
    echo "   Funding GWC Key ($GWC_ADDR) from Millionaire..."
    kubectl exec -n $NAMESPACE $GWC_POD -- gwcd tx bank send "$MILLIONAIRE_KEY" "$GWC_ADDR" "100000000${DENOM}" -y --chain-id "$GWC_CHAIN" --keyring-backend test --home /home/gwc/.gwc
    sleep 5
else
    echo "   GWC Key Balance OK ($BALANCE_GWC)."
fi

# Target側
BIN_NAME="${TARGET_CHAIN%-[0-9]*}d" 
BALANCE_TARGET=$(kubectl exec -n $NAMESPACE "$TARGET_POD_NAME" -- sh -c "$BIN_NAME q bank balances $TARGET_ADDR -o json" | jq -r ".balances[] | select(.denom==\"$DENOM\") | .amount" || echo "0")
if [ -z "$BALANCE_TARGET" ]; then BALANCE_TARGET=0; fi

if [ "$BALANCE_TARGET" -lt "10000000" ]; then
    echo "   Funding Target Key ($TARGET_ADDR) from Millionaire on $TARGET_CHAIN..."
    kubectl exec -n $NAMESPACE "$TARGET_POD_NAME" -- $BIN_NAME tx bank send "$MILLIONAIRE_KEY" "$TARGET_ADDR" "100000000${DENOM}" -y --chain-id "$TARGET_CHAIN" --keyring-backend test --home "/home/${TARGET_CHAIN%-[0-9]*}/.${TARGET_CHAIN%-[0-9]*}"
    sleep 5
else
    echo "   Target Key Balance OK ($BALANCE_TARGET)."
fi


# 4. パス作成とリンク
echo "--> 🔗 Linking Paths..."

# GWCのチェーン設定を更新して、今回の専用鍵を使うようにする
echo "   Updating GWC chain config to use key: $GWC_KEY_NAME"

POD_HOSTNAME="${RELEASE_NAME}-${GWC_CHAIN}-0"
RPC_ADDR="http://${POD_HOSTNAME}.${HEADLESS_SERVICE}:26657"
GRPC_ADDR="http://${POD_HOSTNAME}.${HEADLESS_SERVICE}:9090"

GWC_CONFIG_JSON=$(cat <<EOF
{
  "type": "cosmos",
  "value": {
    "key": "$GWC_KEY_NAME",
    "chain-id": "$GWC_CHAIN",
    "rpc-addr": "$RPC_ADDR",
    "grpc-addr": "$GRPC_ADDR",
    "account-prefix": "cosmos",
    "keyring-backend": "test",
    "gas-adjustment": 1.5,
    "gas-prices": "0.001$DENOM",
    "debug": true,
    "timeout": "20s",
    "output-format": "json",
    "sign-mode": "direct"
  }
}
EOF
)

TMP_FILE="/tmp/gwc.json"
echo "$GWC_CONFIG_JSON" | kubectl exec -i -n $NAMESPACE $RELAYER_POD -- sh -c "cat > $TMP_FILE"
kubectl exec -n $NAMESPACE $RELAYER_POD -- rly chains delete "$GWC_CHAIN" >/dev/null 2>&1 || true
kubectl exec -n $NAMESPACE $RELAYER_POD -- rly chains add --file "$TMP_FILE"
kubectl exec -n $NAMESPACE $RELAYER_POD -- rm "$TMP_FILE"
echo "   GWC config updated."


# Path 1: Gateway
PATH_GW="path-${GWC_CHAIN}-${TARGET_CHAIN}-gw"
SRC_PORT="gateway"
DST_PORT_PREFIX="datastore"
if [[ "$TARGET_CHAIN" == *"mdsc"* ]]; then DST_PORT_PREFIX="metastore"; fi

if ! kubectl exec -n $NAMESPACE $RELAYER_POD -- rly paths show "$PATH_GW" >/dev/null 2>&1; then
    echo "   Creating Path config: $PATH_GW"
    kubectl exec -n $NAMESPACE $RELAYER_POD -- rly paths new "$GWC_CHAIN" "$TARGET_CHAIN" "$PATH_GW" \
        --src-port "$SRC_PORT" --dst-port "$DST_PORT_PREFIX" --version "cryptomeria-1"
fi

echo "   Linking $PATH_GW..."
kubectl exec -n $NAMESPACE $RELAYER_POD -- rly transact link "$PATH_GW" --src-port "$SRC_PORT" --dst-port "$DST_PORT_PREFIX" --version "cryptomeria-1" || echo "   (Link might already be open or failed)"

echo "   Waiting 10s for client state sync..."
sleep 10

# Path 2: Transfer
PATH_TF="path-${GWC_CHAIN}-${TARGET_CHAIN}-tf"
if ! kubectl exec -n $NAMESPACE $RELAYER_POD -- rly paths show "$PATH_TF" >/dev/null 2>&1; then
    echo "   Creating Path config: $PATH_TF"
    kubectl exec -n $NAMESPACE $RELAYER_POD -- rly paths new "$GWC_CHAIN" "$TARGET_CHAIN" "$PATH_TF" \
        --src-port "transfer" --dst-port "transfer" --version "ics20-1"
fi
echo "   Linking $PATH_TF..."
kubectl exec -n $NAMESPACE $RELAYER_POD -- rly transact link "$PATH_TF" --src-port "transfer" --dst-port "transfer" --version "ics20-1" || echo "   (Link might already be open or failed)"


# 5. ストレージ登録
echo "--> 📝 Registering Storage on GWC..."

# チャネルIDの取得 (jqを使ってJSONから抽出)
# ポートが "gateway" かつ 相手チェーンが $TARGET_CHAIN であるものを検索し、最新のもの(tail -n 1)を取得
RAW_CHANNELS=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- rly q channels "$GWC_CHAIN")
CHANNEL_ID=$(echo "$RAW_CHANNELS" | jq -r --arg target "$TARGET_CHAIN" 'select(.port_id=="gateway" and .counterparty.chain_id==$target) | .channel_id' | tail -n 1)

if [ -z "$CHANNEL_ID" ] || [ "$CHANNEL_ID" == "null" ]; then
    echo "⚠️ Warning: Could not find Channel ID for $TARGET_CHAIN. Registration skipped."
    echo "Debug: Raw Channels Output:"
    echo "$RAW_CHANNELS"
else
    echo "   Found Channel ID: $CHANNEL_ID"
    
    TARGET_ENDPOINT="http://${TARGET_POD_NAME}.${HEADLESS_SERVICE}:1317"
    
    kubectl exec -n $NAMESPACE $GWC_POD -- gwcd tx gateway register-storage \
        "$CHANNEL_ID" "$TARGET_CHAIN" "$TARGET_ENDPOINT" \
        --from "$MILLIONAIRE_KEY" --chain-id "$GWC_CHAIN" -y --keyring-backend test --home /home/gwc/.gwc || echo "   (Registration might already exist)"
fi

echo "✅ Connection setup complete for $TARGET_CHAIN"