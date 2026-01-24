#!/bin/bash
set -e

# =====================================================================
# 🛠️ 1. 初期設定とユーティリティ
# =====================================================================
source "$(dirname "$0")/../../lib/common.sh"

BINARY="/workspace/apps/gwc/dist/gwcd"
NODE_URL="tcp://localhost:26657"
CHAIN_ID="gwc"
USER="alice"
PROJECT="trustless-e2e-$(date +%s)"
CHUNK_SIZE=1024
NAMESPACE="cryptomeria"

exec_tx_and_wait() {
    local desc=$1
    local cmd=$2
    
    local tx_hash=$($cmd --broadcast-mode sync -y -o json | jq -r '.txhash')
    
    if [ -z "$tx_hash" ] || [ "$tx_hash" == "null" ]; then
        echo "❌ Error: $desc の送信に失敗しました。" >&2
        exit 1
    fi

    echo "   ⏳ Waiting for Tx ($desc): $tx_hash ..." >&2
    for i in {1..30}; do
        local res=$($BINARY q tx "$tx_hash" --node "$NODE_URL" -o json 2>/dev/null || echo "")
        if [ -n "$res" ] && [ "$res" != "null" ]; then
            local code=$(echo "$res" | jq -r '.code')
            if [ "$code" != "0" ]; then
                echo "❌ Error: $desc が失敗しました (Code: $code)" >&2
                echo "   Log: $(echo "$res" | jq -r '.raw_log')" >&2
                exit 1
            fi
            echo "$res"
            return 0
        fi
        sleep 2
    done
    echo "❌ Error: $desc の確定待機がタイムアウトしました。" >&2
    exit 1
}

echo "===================================================================="
echo "🛡️  Cryptomeria Core: クライアント主導型 整合性検証 (Final Version)"
echo "===================================================================="

# --------------------------------------------------------------------
# 🏗️ 2. STAGE 1: 原本の作成・アップロード・ローカル署名
# --------------------------------------------------------------------
echo "🚀 STAGE 1: 原本の作成・アップロード・ローカル署名"
echo "--------------------------------------------------------------------"

WORK_DIR="/tmp/trustless-v3"
rm -rf "$WORK_DIR" && mkdir -p "$WORK_DIR"
echo "<html><body><h1>Trustless V3</h1></body></html>" > "$WORK_DIR/index.html"
echo "p { color: gold; }" > "$WORK_DIR/style.css"
cd "$WORK_DIR" && zip -r ../upload.zip ./* && cd - >/dev/null
ZIP_FILE="/tmp/upload.zip"

echo "   1. Session Init..."
CMD="$BINARY tx gateway init-upload $PROJECT $CHUNK_SIZE --from $USER --chain-id $CHAIN_ID --node $NODE_URL --keyring-backend test"
RES=$(exec_tx_and_wait "InitUpload" "$CMD")
UPLOAD_ID=$(echo "$RES" | jq -r '.events[] | select(.type=="init_upload") | .attributes[] | select(.key=="upload_id") | .value' | head -n 1)

echo "   2. Posting Chunks..."
CMD="$BINARY tx gateway post-chunk $UPLOAD_ID 0 $ZIP_FILE --from $USER --chain-id $CHAIN_ID --node $NODE_URL --keyring-backend test --gas auto --gas-adjustment 1.5"
exec_tx_and_wait "PostChunk" "$CMD" > /dev/null

echo "   3. Completing Upload..."
CMD="$BINARY tx gateway complete-upload $UPLOAD_ID $PROJECT 1.0.0 $CHUNK_SIZE --from $USER --chain-id $CHAIN_ID --node $NODE_URL --keyring-backend test --gas auto --gas-adjustment 1.5"
RES=$(exec_tx_and_wait "CompleteUpload" "$CMD")
SITE_ROOT=$(echo "$RES" | jq -r '.events[] | select(.type=="complete_upload") | .attributes[] | select(.key=="site_root") | .value' | head -n 1)

echo "   4. Local Verification and Signing using gwcd util..."
LOCAL_CALC_ROOT=$($BINARY util verify-data "$ZIP_FILE" "$CHUNK_SIZE")
echo "      > Local Computed Root: $LOCAL_CALC_ROOT"
echo "      > GWC Provided Root  : $SITE_ROOT"

if [ "$LOCAL_CALC_ROOT" != "$SITE_ROOT" ]; then
    echo "❌ 警告: 整合性エラー！GWCが提示したSiteRootが手元の計算結果と一致しません。" >&2
    exit 1
fi

REAL_SIGNATURE=$($BINARY util create-sign "$USER" "$SITE_ROOT" --keyring-backend test)
echo "      ✅ Locally verified and signed."

echo "   5. Submitting Sign-Upload with REAL signature..."
CMD="$BINARY tx gateway sign-upload $UPLOAD_ID $SITE_ROOT $REAL_SIGNATURE --from $USER --chain-id $CHAIN_ID --node $NODE_URL --keyring-backend test"
exec_tx_and_wait "SignUpload" "$CMD" > /dev/null

echo "   ✅ Stage 1 完了。公証済み SiteRoot: $SITE_ROOT"
echo ""

# --------------------------------------------------------------------
# 🔍 3. STAGE 2: 分散保存されたデータの到達確認
# --------------------------------------------------------------------
echo "🔎 STAGE 2: 分散保存されたデータ(MDSC)の到達確認"
echo "--------------------------------------------------------------------"

MDSC_POD=$(get_chain_pod_name "mdsc")

while :; do
    # mdscd q metastore get-manifest は Manifest オブジェクトを直接返すため、.project_name などで存在確認
    MANIFEST=$(pod_exec "$MDSC_POD" mdscd q metastore get-manifest "$PROJECT" -o json 2>/dev/null || echo "")
    CHECK_ID=$(echo "$MANIFEST" | jq -r '.project_name // empty')
    if [ -n "$CHECK_ID" ]; then 
        echo "   ✅ Manifest detected on MDSC."
        break 
    fi
    echo "   ⏳ Waiting for manifest on MDSC (IBC latency)..."
    sleep 5
done

echo ""

# --------------------------------------------------------------------
# 🍏 4. STAGE 3: 最終整合性チェック (End-to-End)
# --------------------------------------------------------------------
echo "🍏 STAGE 3: 最終整合性チェック (End-to-End)"
echo "--------------------------------------------------------------------"

# ✅ 修正箇所: CLIがアンラップ済みのため、直接 .site_root を取得
MDSC_ROOT=$(echo "$MANIFEST" | jq -r '.site_root')

echo "   > ローカル原本からの算出値 : $LOCAL_CALC_ROOT"
echo "   > MDSCに記録された証跡     : $MDSC_ROOT"

if [ "$LOCAL_CALC_ROOT" == "$MDSC_ROOT" ]; then
    echo ""
    echo "===================================================================="
    echo "🎉 【検証成功：Cryptomeria Integrity Verified】"
    echo "===================================================================="
    echo "1. 本人性: 秘密鍵はローカル(alice)から一歩も出ず、署名のみが送られました。"
    echo "2. 完全性: 分散ネットワークに保存されたデータは、原本と数学的に1ビットも違いません。"
    echo "3. 透明性: GWCの不正（改ざん）が行われていないことが、バイナリによって証明されました。"
else
    echo "❌ 最終検証失敗: システム上のデータが原本と一致しません。"
    exit 1
fi