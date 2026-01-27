#!/bin/bash
set -e

NAMESPACE="cryptomeria"
APP_NAME="gwc"
POD_NAME=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/component=$APP_NAME -o jsonpath="{.items[0].metadata.name}")

echo "=========================================="
echo "🕵️‍♂️ GWC Chaos Debugger"
echo "Target Pod: $POD_NAME"
echo "=========================================="

# 1. ログの中に「DEBUG: RegisterAPIRoutes」があるか確認
# これがあれば「コードは最新だが、通信経路がおかしい」。なければ「コードが古い」。
echo ""
echo "🔍 [Check 1] Checking Logs for Application Wiring..."
if kubectl logs -n "$NAMESPACE" "$POD_NAME" | grep -q "RegisterAPIRoutes"; then
    echo "✅ FOUND: 'RegisterAPIRoutes' log found. The code IS running."
    kubectl logs -n "$NAMESPACE" "$POD_NAME" | grep "RegisterAPIRoutes" | head -n 5
else
    echo "❌ MISSING: 'RegisterAPIRoutes' log NOT found."
    echo "   👉 CONCLUSION: The running binary does NOT contain the new app.go code."
fi

# 2. バイナリのハッシュ比較
# ローカルでビルドしたバイナリと、Podの中のバイナリが同一か確認
echo ""
echo "🔍 [Check 2] Comparing Binaries (Local vs Pod)..."
LOCAL_HASH=$(md5sum apps/gwc/dist/gwcd | awk '{print $1}')
POD_HASH=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -- md5sum /usr/local/bin/gwcd | awk '{print $1}') 
# ※ パスはDockerfileの実装によりますが、通常 /usr/local/bin か /home/gwc/go/bin です。
# エラーが出たら /home/gwc/bin/gwcd などに変えてみてください。

echo "   Local: $LOCAL_HASH"
echo "   Pod  : $POD_HASH"

if [ "$LOCAL_HASH" == "$POD_HASH" ]; then
    echo "✅ Match: Binaries are identical."
else
    echo "❌ MISMATCH: Binaries are different!"
    echo "   👉 CONCLUSION: The Pod is running an old image or build failed."
fi

# 3. アカウントと残高の直接確認
# PortForwardを経由せず、Pod内部から直接自身の状態を問い合わせる
echo ""
echo "🔍 [Check 3] Checking Account 'alice' inside Pod..."
ALICE_ADDR=$(apps/gwc/dist/gwcd keys show alice -a --keyring-backend test 2>/dev/null || echo "unknown")
echo "   Alice Address (Local): $ALICE_ADDR"

echo "   Querying Bank Balance inside Pod..."
kubectl exec -n "$NAMESPACE" "$POD_NAME" -- gwcd q bank balances "$ALICE_ADDR" --output json

# 4. ポートフォワードとPingテスト
echo ""
echo "🔍 [Check 4] Testing Port Forward & Ping..."
# バックグラウンドでポートフォワード
kubectl port-forward -n "$NAMESPACE" pod/"$POD_NAME" 9999:1317 > /dev/null 2>&1 &
PF_PID=$!
sleep 2

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:9999/ping)
echo "   Response Code: $HTTP_CODE"

if [ "$HTTP_CODE" == "200" ]; then
    echo "✅ Ping OK (200)"
elif [ "$HTTP_CODE" == "501" ]; then
    echo "❌ Ping Failed (501 Not Implemented)"
    echo "   👉 CONCLUSION: The server is running, but the custom handler is missing."
else
    echo "⚠️  Ping Failed (Code: $HTTP_CODE)"
fi

# クリーンアップ
kill $PF_PID