#!/bin/bash
set -e

# =============================================================================
# 🛠️ 1. 初期設定とユーティリティ関数
# =============================================================================
source "$(dirname "$0")/../../lib/common.sh"

BINARY="/workspace/apps/gwc/dist/gwcd"
NODE_URL="tcp://localhost:26657"
CHAIN_ID="gwc"
USER="alice"
PROJECT="trustless-e2e-$(date +%s)"
CHUNK_SIZE=1024
NAMESPACE="cryptomeria"

# トランザクションを送信し、確定を待機してイベント結果を返す関数
# $1: コマンド名, $2: 実行コマンド文字列
exec_tx_and_wait() {
    local desc=$1
    local cmd=$2
    
    # Txを送信 (syncモードでハッシュを即時取得)
    local tx_hash=$($cmd --broadcast-mode sync -y -o json | jq -r '.txhash')
    
    if [ -z "$tx_hash" ] || [ "$tx_hash" == "null" ]; then
        echo "❌ Error: $desc の送信に失敗しました。" >&2
        exit 1
    fi

    echo "   ⏳ Waiting for Tx ($desc): $tx_hash ..." >&2
    for i in {1..30}; do
        local res=$($BINARY q tx "$tx_hash" --node "$NODE_URL" -o json 2>/dev/null || echo "")
        if [ -n "$res" ] && [ "$res" != "null" ]; then
            # 成功時、結果のJSONを返す
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
# 🏗️ 2. STAGE 1: データの作成とアップロード (本人署名)
# --------------------------------------------------------------------
echo "🚀 STAGE 1: 原本の作成・アップロード・ローカル署名"
echo "--------------------------------------------------------------------"

# ファイル準備
WORK_DIR="/tmp/trustless-v3"
rm -rf "$WORK_DIR" && mkdir -p "$WORK_DIR"
echo "<html><body><h1>Trustless V3</h1></body></html>" > "$WORK_DIR/index.html"
echo "p { color: gold; }" > "$WORK_DIR/style.css"
cd "$WORK_DIR" && zip -r ../upload.zip ./* && cd - >/dev/null
ZIP_FILE="/tmp/upload.zip"

# 1. Init Upload
echo "   1. Session Init..."
CMD="$BINARY tx gateway init-upload $PROJECT $CHUNK_SIZE --from $USER --chain-id $CHAIN_ID --node $NODE_URL --keyring-backend test"
RES=$(exec_tx_and_wait "InitUpload" "$CMD")
# イベントからUploadIDを抽出 (最初の1つを確実に取得)
UPLOAD_ID=$(echo "$RES" | jq -r '.events[] | select(.type=="init_upload") | .attributes[] | select(.key=="upload_id") | .value' | head -n 1)

# 2. Post Chunk
echo "   2. Posting Chunks..."
CMD="$BINARY tx gateway post-chunk $UPLOAD_ID 0 $ZIP_FILE --from $USER --chain-id $CHAIN_ID --node $NODE_URL --keyring-backend test --gas auto --gas-adjustment 1.5"
exec_tx_and_wait "PostChunk" "$CMD" > /dev/null

# 3. Complete Upload
echo "   3. Completing Upload..."
CMD="$BINARY tx gateway complete-upload $UPLOAD_ID $PROJECT 1.0.0 $CHUNK_SIZE --from $USER --chain-id $CHAIN_ID --node $NODE_URL --keyring-backend test --gas auto --gas-adjustment 1.5"
RES=$(exec_tx_and_wait "CompleteUpload" "$CMD")
SITE_ROOT=$(echo "$RES" | jq -r '.events[] | select(.type=="complete_upload") | .attributes[] | select(.key=="site_root") | .value' | head -n 1)

# 4. Local Signing
echo "   4. Generating Local Signature (Alice's Secret Key Simulation)..."
# 秘密鍵はAliceの手元から出さない
REAL_SIGNATURE=$(node - <<EOF
const crypto = require('crypto');
const privKey = crypto.createHash('sha256').update('alice-secret-key').digest();
const sig = crypto.createHmac('sha256', privKey).update(Buffer.from('$SITE_ROOT', 'hex')).digest('base64');
process.stdout.write(sig);
EOF
)

# 5. Sign Upload (バグ修正: $CHAIN_ID のケースミスを修正)
echo "   5. Submitting Sign-Upload with REAL signature..."
CMD="$BINARY tx gateway sign-upload $UPLOAD_ID $SITE_ROOT $REAL_SIGNATURE --from $USER --chain-id $CHAIN_ID --node $NODE_URL --keyring-backend test"
exec_tx_and_wait "SignUpload" "$CMD" > /dev/null

echo "   ✅ Stage 1 完了。公証された SiteRoot: $SITE_ROOT"
echo ""

# --------------------------------------------------------------------
# 🔍 3. STAGE 2: 分散保存されたデータの再構成検証
# --------------------------------------------------------------------
echo "🔎 STAGE 2: 分散保存されたデータからの再構成検証"
echo "--------------------------------------------------------------------"

MDSC_POD=$(get_chain_pod_name "mdsc")
GWC_POD=$(get_chain_pod_name "gwc")

# MDSCへの到達をポーリング
while :; do
    MANIFEST=$(pod_exec "$MDSC_POD" mdscd q metastore get-manifest "$PROJECT" -o json 2>/dev/null || echo "")
    if [ -n "$MANIFEST" ] && [ "$MANIFEST" != "null" ]; then break; fi
    echo "   ⏳ Waiting for manifest on MDSC..."
    sleep 3
done

RECONSTRUCTED_ROOT=$(node - <<EOF
const crypto = require('crypto');
const exec = require('child_process').execSync;

const manifest = $MANIFEST;
const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');

function getMerkleRoot(hashes) {
    if (hashes.length <= 1) return hashes[0] || "";
    let level = [...hashes];
    if (level.length % 2 !== 0) level.push(level[level.length - 1]);
    let next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(level[i] + level[i + 1]));
    return getMerkleRoot(next);
}

const fileLeafHashes = Object.keys(manifest.files).sort().map(path => {
    const file = manifest.files[path];
    const fragLeafHashes = file.fragments.map((frag, i) => {
        // Pod名の特定 (命名規則: RELEASE-CHAINID-0)
        const endp = JSON.parse(exec("kubectl exec $GWC_POD -- gwcd q gateway endpoints -o json").toString());
        const chain = endp.storage_infos.find(s => s.channel_id === frag.fdsc_id).chain_id;
        const pod = "${RELEASE_NAME}-" + chain + "-0";
        const res = JSON.parse(exec(\`kubectl exec -n $NAMESPACE \${pod} -- fdscd q datastore get-fragment \${frag.fragment_id} -o json\`).toString());
        const dataHash = sha256(Buffer.from(res.fragment.data, 'base64'));
        return sha256(\`FRAG:\${path}:\${i}:\${dataHash}\`);
    });
    return sha256(\`FILE:\${path}:\${file.file_size}:\${getMerkleRoot(fragLeafHashes)}\`);
});

process.stdout.write(getMerkleRoot(fileLeafHashes));
EOF
)

if [ "$RECONSTRUCTED_ROOT" == "$SITE_ROOT" ]; then
    echo "   ✅ 成功: 分散保存データから計算したハッシュが、目録(SiteRoot)と一致しました。"
else
    echo "   ❌ 失敗: データ整合性不一致！ ($RECONSTRUCTED_ROOT vs $SITE_ROOT)"
    exit 1
fi
echo ""

# --------------------------------------------------------------------
# 🍏 4. STAGE 3: ローカル原本の独立検証
# --------------------------------------------------------------------
echo "🍏 STAGE 3: クライアント手元の原本（Local Original）による独立検証"
echo "--------------------------------------------------------------------"

LOCAL_ROOT=$(node - <<EOF
const crypto = require('crypto');
const fs = require('fs');
const exec = require('child_process').execSync;

const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
function getMerkleRoot(hashes) {
    if (hashes.length <= 1) return hashes[0] || "";
    let level = [...hashes];
    if (level.length % 2 !== 0) level.push(level[level.length - 1]);
    let next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(level[i] + level[i + 1]));
    return getMerkleRoot(next);
}

exec(\`rm -rf /tmp/v && mkdir -p /tmp/v && unzip $ZIP_FILE -d /tmp/v\`);
const files = [];
const walk = (d, b = '') => {
    fs.readdirSync(d).forEach(f => {
        const p = d + '/' + f, rel = b ? b + '/' + f : f;
        if (fs.statSync(p).isDirectory()) walk(p, rel);
        else files.push({ path: rel, content: fs.readFileSync(p) });
    });
};
walk('/tmp/v');
files.sort((a, b) => a.path.localeCompare(b.path));

const fileLeafHashes = files.map(file => {
    const frags = [];
    for (let i = 0, idx = 0; i < file.content.length; i += $CHUNK_SIZE, idx++) {
        const chunk = file.content.slice(i, i + $CHUNK_SIZE);
        frags.push(sha256(\`FRAG:\${file.path}:\${idx}:\${sha256(chunk)}\`));
    }
    return sha256(\`FILE:\${file.path}:\${file.content.length}:\${getMerkleRoot(frags)}\`);
});

process.stdout.write(getMerkleRoot(fileLeafHashes));
EOF
)

echo "   > ローカル算出値 : $LOCAL_ROOT"
echo "   > 署名済み証跡   : $SITE_ROOT"

if [ "$LOCAL_ROOT" == "$SITE_ROOT" ]; then
    echo ""
    echo "===================================================================="
    echo "🎉 【検証合格：合格】"
    echo "===================================================================="
    echo "1. 本人性: Aliceの秘密鍵でローカル署名を行い、インフラに鍵を渡していません。"
    echo "2. 完全性: あなたのZIP原本こそが、唯一の数学的正解であることを証明しました。"
else
    echo "❌ 最終検証失敗: 手元の原本とシステム上のデータが一致しません。"
    exit 1
fi