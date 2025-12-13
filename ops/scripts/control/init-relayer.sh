#!/bin/bash
set -e

# --- 設定 ---
NAMESPACE=${NAMESPACE:-"cryptomeria"}
RELEASE_NAME=${RELEASE_NAME:-"cryptomeria"}
HEADLESS_SERVICE="cryptomeria-chain-headless"
DENOM="uatom"
KEY_NAME="relayer"

# 対象チェーンのリスト (配列)
CHAINS=("gwc" "mdsc" "fdsc-0") 
# ※必要に応じて fdsc-1, fdsc-2... を引数で増やせるように拡張可能ですが、
#   まずはPhase2テストを通すために固定または最小構成にします。

echo "=== Initializing Relayer Configuration (Control Script) ==="

# 1. Relayer Podの特定
echo "--> 🔍 Finding Relayer Pod..."
RELAYER_POD=$(kubectl get pod -n $NAMESPACE -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")

if [ -z "$RELAYER_POD" ]; then
    echo "❌ Error: Relayer pod not found in namespace '$NAMESPACE'."
    exit 1
fi
echo "   Target Pod: $RELAYER_POD"

# 2. rly config init (冪等性を考慮)
echo "--> ⚙️  Initializing config..."
# すでに設定があるか確認
if kubectl exec -n $NAMESPACE $RELAYER_POD -- test -f /home/relayer/.relayer/config/config.yaml; then
    echo "   Config already exists. Skipping 'rly config init'."
else
    kubectl exec -n $NAMESPACE $RELAYER_POD -- rly config init --memo "Cryptomeria Relayer"
    echo "   Initialized new config."
fi

# 3. チェーン設定の追加
echo "--> 🔗 Adding chain configurations..."

for CHAIN_ID in "${CHAINS[@]}"; do
    echo "   Processing: $CHAIN_ID"
    
    # K8s内部DNS名の構築
    # StatefulSetのPod名: [Release]-[Chain]-0
    # Headless Service: [Release]-chain-headless
    # FQDN: [PodName].[HeadlessService].[Namespace].svc.cluster.local
    POD_HOSTNAME="${RELEASE_NAME}-${CHAIN_ID}-0"
    RPC_ADDR="http://${POD_HOSTNAME}.${HEADLESS_SERVICE}:26657"
    GRPC_ADDR="http://${POD_HOSTNAME}.${HEADLESS_SERVICE}:9090"
    
    # 設定JSONの生成
    # EOFの展開を変数展開させるため、'EOF' ではなく EOF を使用
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
    
    # チェーン追加コマンド実行 (すでに存在する場合はスキップするかエラーを許容する)
    # rly chains add は上書きしないので、追加前にリストを確認するか、エラーを無視する
    # ここでは grep で存在確認してから追加する丁寧な実装にします
    if kubectl exec -n $NAMESPACE $RELAYER_POD -- rly chains list | grep -q "$CHAIN_ID"; then
        echo "     -> Chain '$CHAIN_ID' already exists. Skipping."
    else
        kubectl exec -n $NAMESPACE $RELAYER_POD -- rly chains add --file "$TMP_FILE"
        echo "     -> Chain '$CHAIN_ID' added."
    fi
    
    # 一時ファイル削除
    kubectl exec -n $NAMESPACE $RELAYER_POD -- rm "$TMP_FILE"
done

echo "✅ Relayer configuration complete."