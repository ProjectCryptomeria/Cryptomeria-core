#!/bin/bash
set -e

# --- 設定 ---
NAMESPACE=${NAMESPACE:-"cryptomeria"}
RELEASE_NAME=${RELEASE_NAME:-"cryptomeria"}
HEADLESS_SERVICE="cryptomeria-chain-headless"
DENOM="uatom"
KEY_NAME="relayer"

echo "=== Initializing Relayer Configuration (Control Script) ==="

# 1. Relayer Podの特定
echo "--> 🔍 Finding Relayer Pod..."
RELAYER_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")

if [ -z "$RELAYER_POD" ]; then
    echo "❌ Error: Relayer pod not found in namespace '$NAMESPACE'."
    exit 1
fi
echo "    Target Pod: $RELAYER_POD"

# 2. 対象チェーンの動的検出 (category=chain を使用)
echo "--> 🔍 Discovering target chains..."

# app.kubernetes.io/category=chain のラベルを持つPodを全て検索し、
# app.kubernetes.io/instance ラベル（チェーンID）を取得して重複排除・ソートする
RAW_CHAINS=$(kubectl get pods -n $NAMESPACE \
  -l 'app.kubernetes.io/category=chain' \
  -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/instance}{"\n"}{end}' \
  | sort | uniq)

# 配列に変換
CHAINS=($RAW_CHAINS)

if [ ${#CHAINS[@]} -eq 0 ]; then
    echo "❌ Error: No running chains found. Did you run 'just deploy'?"
    exit 1
fi

echo "    Found Chains: ${CHAINS[*]}"

# 3. rly config init (冪等性を考慮)
echo "--> ⚙️  Initializing config..."
# 設定ファイルの存在確認
if kubectl exec -n $NAMESPACE $RELAYER_POD -- test -f /home/relayer/.relayer/config/config.yaml; then
    echo "    Config already exists. Skipping 'rly config init'."
else
    # rly config init は標準エラーに警告を出す可能性があるため、2>/dev/null で無視
    kubectl exec -n $NAMESPACE $RELAYER_POD -- rly config init --memo "Cryptomeria Relayer" 2>/dev/null
    echo "    Initialized new config."
fi

# 4. チェーン設定の追加
echo "--> 🔗 Adding chain configurations..."

for CHAIN_ID in "${CHAINS[@]}"; do
    echo "    Processing: $CHAIN_ID"
    
    # K8s内部DNS名の構築
    # 前提: Pod名は [Release]-[Instance]-0 の形式であること
    POD_HOSTNAME="${RELEASE_NAME}-${CHAIN_ID}-0"
    RPC_ADDR="http://${POD_HOSTNAME}.${HEADLESS_SERVICE}:26657"
    GRPC_ADDR="http://${POD_HOSTNAME}.${HEADLESS_SERVICE}:9090"
    
    # 設定JSONの生成
    CONFIG_JSON=$(cat <<EOF
{
  "type": "cosmos",
  "value": {
    "key": "$KEY_NAME",
    "chain-id": "$CHAIN_ID",
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
    
    # JSONをPod内の一時ファイルに書き込む
    TMP_FILE="/tmp/${CHAIN_ID}.json"
    echo "$CONFIG_JSON" | kubectl exec -i -n $NAMESPACE $RELAYER_POD -- sh -c "cat > $TMP_FILE"
    
    # チェーン追加コマンド実行
    # rly chains list が警告を出す可能性があるため、2>/dev/null で無視
    if kubectl exec -n $NAMESPACE $RELAYER_POD -- rly chains list 2>/dev/null | grep -q "$CHAIN_ID"; then
        echo "      -> Chain '$CHAIN_ID' already exists. Skipping."
    else
        # rly chains add も標準エラーに警告を出す可能性があるため、2>/dev/null で無視
        kubectl exec -n $NAMESPACE $RELAYER_POD -- rly chains add --file "$TMP_FILE" 2>/dev/null
        echo "      -> Chain '$CHAIN_ID' added."
    fi
    
    # 一時ファイル削除
    kubectl exec -n $NAMESPACE $RELAYER_POD -- rm "$TMP_FILE"
done

echo "✅ Relayer configuration complete."