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

# 2. 鍵の定義
# GWC側: 接続先ごとにユニークな鍵を使う
GWC_KEY_NAME="rly-${TARGET_CHAIN}"
# Target側: 共通の 'relayer' 鍵を使う
TARGET_KEY_NAME="relayer"

echo "--> 🔑 Preparing Keys..."
echo "    GWC Side Key:    $GWC_KEY_NAME"
echo "    Target Side Key: $TARGET_KEY_NAME"

# --- GWC側の鍵 (ユニーク) ---
if ! kubectl exec -n $NAMESPACE $RELAYER_POD -- rly keys show "$GWC_CHAIN" "$GWC_KEY_NAME" >/dev/null 2>&1; then
    echo "   Creating key '$GWC_KEY_NAME' on $GWC_CHAIN..."
    kubectl exec -n $NAMESPACE $RELAYER_POD -- rly keys add "$GWC_CHAIN" "$GWC_KEY_NAME"
else
    echo "   Key '$GWC_KEY_NAME' exists on GWC."
fi
GWC_ADDR=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- rly keys show "$GWC_CHAIN" "$GWC_KEY_NAME" )

# --- Target側の鍵 (共通) ---
if ! kubectl exec -n $NAMESPACE $RELAYER_POD -- rly keys show "$TARGET_CHAIN" "$TARGET_KEY_NAME" >/dev/null 2>&1; then
    echo "   Creating key '$TARGET_KEY_NAME' on $TARGET_CHAIN..."
    kubectl exec -n $NAMESPACE $RELAYER_POD -- rly keys add "$TARGET_CHAIN" "$TARGET_KEY_NAME"
else
    echo "   Key '$TARGET_KEY_NAME' exists on Target."
fi
TARGET_ADDR=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- rly keys show "$TARGET_CHAIN" "$TARGET_KEY_NAME")


# 3. Faucet (資金注入)
echo "--> ⛽ Checking Balance & Faucet..."

# GWC側
BALANCE_GWC=$(kubectl exec -n $NAMESPACE $GWC_POD -- gwcd q bank balances "$GWC_ADDR" -o json | jq -r ".balances[] | select(.denom==\"$DENOM\") | .amount" || echo "0")
if [ -z "$BALANCE_GWC" ]; then BALANCE_GWC=0; fi

if [ "$BALANCE_GWC" -lt "10000000" ]; then
    echo "   Funding GWC Key ($GWC_ADDR)..."
    kubectl exec -n $NAMESPACE $GWC_POD -- gwcd tx bank send "$MILLIONAIRE_KEY" "$GWC_ADDR" "100000000${DENOM}" -y --chain-id "$GWC_CHAIN" --keyring-backend test --home /home/gwc/.gwc
    sleep 2
else
    echo "   GWC Key Balance OK ($BALANCE_GWC)."
fi

# Target側
BIN_NAME="${TARGET_CHAIN%-[0-9]*}d" 
BALANCE_TARGET=$(kubectl exec -n $NAMESPACE "$TARGET_POD_NAME" -- sh -c "$BIN_NAME q bank balances $TARGET_ADDR -o json" | jq -r ".balances[] | select(.denom==\"$DENOM\") | .amount" || echo "0")
if [ -z "$BALANCE_TARGET" ]; then BALANCE_TARGET=0; fi

if [ "$BALANCE_TARGET" -lt "10000000" ]; then
    echo "   Funding Target Key ($TARGET_ADDR)..."
    kubectl exec -n $NAMESPACE "$TARGET_POD_NAME" -- $BIN_NAME tx bank send "$MILLIONAIRE_KEY" "$TARGET_ADDR" "100000000${DENOM}" -y --chain-id "$TARGET_CHAIN" --keyring-backend test --home "/home/${TARGET_CHAIN%-[0-9]*}/.${TARGET_CHAIN%-[0-9]*}"
    sleep 2
else
    echo "   Target Key Balance OK ($BALANCE_TARGET)."
fi


# 4. パス作成とリンク
echo "--> 🔗 Linking Paths..."

# 使用する鍵をConfigに適用 (直列実行なので安全)
echo "   Updating chain configs to use correct keys..."
kubectl exec -n $NAMESPACE $RELAYER_POD -- rly chains add "$GWC_CHAIN" key "$GWC_KEY_NAME"
kubectl exec -n $NAMESPACE $RELAYER_POD -- rly chains add "$TARGET_CHAIN" key "$TARGET_KEY_NAME"

# Path 1: Gateway
PATH_GW="path-${GWC_CHAIN}-${TARGET_CHAIN}-gw"
SRC_PORT="gateway"
DST_PORT_PREFIX="datastore"
if [[ "$TARGET_CHAIN" == *"mdsc"* ]]; then DST_PORT_PREFIX="metastore"; fi

if ! kubectl exec -n $NAMESPACE $RELAYER_POD -- rly paths show "$PATH_GW" >/dev/null 2>&1; then
    kubectl exec -n $NAMESPACE $RELAYER_POD -- rly paths new "$GWC_CHAIN" "$TARGET_CHAIN" "$PATH_GW" \
        --src-port "$SRC_PORT" --dst-port "$DST_PORT_PREFIX" --version "cryptomeria-1"
fi

# Path 2: Transfer
PATH_TF="path-${GWC_CHAIN}-${TARGET_CHAIN}-tf"
if ! kubectl exec -n $NAMESPACE $RELAYER_POD -- rly paths show "$PATH_TF" >/dev/null 2>&1; then
    kubectl exec -n $NAMESPACE $RELAYER_POD -- rly paths new "$GWC_CHAIN" "$TARGET_CHAIN" "$PATH_TF" \
        --src-port "transfer" --dst-port "transfer" --version "ics20-1"
fi

# リンク実行
echo "   Linking $PATH_GW..."
kubectl exec -n $NAMESPACE $RELAYER_POD -- rly transact link "$PATH_GW" --src-port "$SRC_PORT" --dst-port "$DST_PORT_PREFIX" --version "cryptomeria-1" || echo "   (Link might already be open or failed)"

echo "   Linking $PATH_TF..."
kubectl exec -n $NAMESPACE $RELAYER_POD -- rly transact link "$PATH_TF" --src-port "transfer" --dst-port "transfer" --version "ics20-1" || echo "   (Link might already be open or failed)"

echo "   Waiting 5s for client state sync..."
sleep 5


# 5. ストレージ登録 (GWCへのTX送信)
echo "--> 📝 Registering Storage on GWC..."

# チャネルIDの取得
RAW_CHANNELS=$(kubectl exec -n $NAMESPACE $RELAYER_POD -- rly q channels "$GWC_CHAIN")
CHANNEL_ID=$(echo "$RAW_CHANNELS" | jq -r --arg target "$TARGET_CHAIN" 'select(.port_id=="gateway" and .counterparty.chain_id==$target) | .channel_id' | tail -n 1)

if [ -z "$CHANNEL_ID" ] || [ "$CHANNEL_ID" == "null" ]; then
    echo "⚠️ Warning: Could not find Channel ID for $TARGET_CHAIN. Registration skipped."
else
    echo "   Found Channel ID: $CHANNEL_ID"
    TARGET_ENDPOINT="http://${TARGET_POD_NAME}.${HEADLESS_SERVICE}:1317"
    
    # 登録トランザクション
    kubectl exec -n $NAMESPACE $GWC_POD -- gwcd tx gateway register-storage \
        "$CHANNEL_ID" "$TARGET_CHAIN" "$TARGET_ENDPOINT" \
        --from "$MILLIONAIRE_KEY" --chain-id "$GWC_CHAIN" -y --keyring-backend test --home /home/gwc/.gwc || echo "   (Registration might already exist)"
fi

echo "✅ Connection setup complete for $TARGET_CHAIN"