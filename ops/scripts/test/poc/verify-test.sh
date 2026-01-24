#!/bin/bash
set -e

# 共通ライブラリの読み込み
source "$(dirname "$0")/../../lib/common.sh"

echo "===================================================================="
echo "🛡️  Cryptomeria Core: データの数学的正当性 精密検証レポート"
echo "===================================================================="
echo "この検証では、GWCが定義した Merkle Tree アルゴリズムを完全に再現し、"
echo "保存された実データから SiteRoot が導き出せるかを数学的に証明します。"
echo ""

# 1. ターゲットPodの特定
GWC_POD=$(get_chain_pod_name "gwc")
MDSC_POD=$(get_chain_pod_name "mdsc")

if [ -z "$MDSC_POD" ]; then
    echo "❌ エラー: MDSCノードが見つかりません。"
    exit 1
fi

# 2. 最新のマニフェストを取得
echo "🔎 [工程 1] ブロックチェーン(MDSC)から公証された目録を取得"
echo "--------------------------------------------------------------------"
MANIFEST_LIST=$(pod_exec "$MDSC_POD" mdscd q metastore list-manifest -o json)
LATEST_PROJECT=$(echo "$MANIFEST_LIST" | jq -r '.manifest[-1].project_name')

if [ "$LATEST_PROJECT" == "null" ] || [ -z "$LATEST_PROJECT" ]; then
    echo "❌ エラー: 検証対象のマニフェストが存在しません。"
    exit 1
fi

MANIFEST=$(pod_exec "$MDSC_POD" mdscd q metastore get-manifest "$LATEST_PROJECT" -o json)
EXPECTED_SITE_ROOT=$(echo "$MANIFEST" | jq -r '.site_root')

echo "   > プロジェクト : $LATEST_PROJECT"
echo "   > 期待される SiteRoot : $EXPECTED_SITE_ROOT"
echo ""

# 3. FDSCから全データを回収し、ハッシュマップを作成
echo "💾 [工程 2] ストレージ(FDSC)から実データを回収し、中身を照合"
echo "--------------------------------------------------------------------"

# マニフェスト内の全断片について、ID -> SHA256(実データ) のマッピングを作成
# これにより、計算に使用する「真のデータハッシュ」を特定します。
FRAGMENT_HASH_MAP_JSON=$(echo "{}" | jq '.')

FILE_PATHS=$(echo "$MANIFEST" | jq -r '.files | keys[]' | sort)

for FILE_PATH in $FILE_PATHS; do
    echo "   📄 ファイル検証中: $FILE_PATH"
    FRAG_COUNT=$(echo "$MANIFEST" | jq -r ".files[\"$FILE_PATH\"].fragments | length")
    
    for (( i=0; i<$FRAG_COUNT; i++ )); do
        FRAG_INFO=$(echo "$MANIFEST" | jq -c ".files[\"$FILE_PATH\"].fragments[$i]")
        CHANNEL_ID=$(echo "$FRAG_INFO" | jq -r '.fdsc_id')
        FRAG_ID=$(echo "$FRAG_INFO" | jq -r '.fragment_id')
        
        # FDSCからデータを直接取得
        FDSC_CHAIN=$(pod_exec "$GWC_POD" gwcd q gateway endpoints -o json | jq -r --arg CH "$CHANNEL_ID" '.storage_infos[] | select(.channel_id==$CH) | .chain_id' | head -n 1)
        FDSC_POD=$(get_chain_pod_name "$FDSC_CHAIN")
        FRAG_DATA_B64=$(pod_exec "$FDSC_POD" fdscd q datastore get-fragment "$FRAG_ID" -o json | jq -r '.fragment.data')
        
        # 実データの SHA256 を計算（これが Merkle Tree の計算の核になります）
        DATA_SHA256=$(echo "$FRAG_DATA_B64" | base64 -d | sha256sum | cut -d' ' -f1)
        
        # マッピングを更新
        FRAGMENT_HASH_MAP_JSON=$(echo "$FRAGMENT_HASH_MAP_JSON" | jq --arg ID "$FRAG_ID" --arg HASH "$DATA_SHA256" '. + {($ID): $HASH}')
        echo "      - 断片 [$i] (ID: $FRAG_ID) ... ✅ データハッシュ確認 ($DATA_SHA256)"
    done
done
echo ""

# 4. Node.jsによる計算ロジック（merkle_logic.go を完全再現）
echo "📐 [工程 3] マークルツリーの数学的再構築"
echo "--------------------------------------------------------------------"
echo "   GWCのアルゴリズムに基づき、実データから SiteRoot を再計算します。"

CALCULATED_SITE_ROOT=$(node - <<EOF
const crypto = require('crypto');

const manifest = $MANIFEST;
const fragHashMap = $FRAGMENT_HASH_MAP_JSON;

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

// merkle_logic.go の calculateMerkleRoot ロジックを正確に再現
function calculateMerkleRoot(hashes) {
    if (hashes.length === 0) return "";
    if (hashes.length === 1) return hashes[0];

    // 要素数が奇数の場合、最後を複製
    let currentLevel = [...hashes];
    if (currentLevel.length % 2 !== 0) {
        currentLevel.push(currentLevel[currentLevel.length - 1]);
    }

    let nextLevel = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
        const combined = currentLevel[i] + currentLevel[i + 1];
        nextLevel.push(sha256(combined));
    }
    return calculateMerkleRoot(nextLevel);
}

const fileLeafHashes = [];
const sortedPaths = Object.keys(manifest.files).sort();

for (const path of sortedPaths) {
    const fileInfo = manifest.files[path];
    const fragLeafHashes = [];

    fileInfo.fragments.forEach((frag, index) => {
        const dataHash = fragHashMap[frag.fragment_id];
        // Go: hashFragmentEntry -> "FRAG:path:index:dataHash"
        const rawFrag = \`FRAG:\${path}:\${index}:\${dataHash}\`;
        fragLeafHashes.push(sha256(rawFrag));
    });

    const fileRoot = calculateMerkleRoot(fragLeafHashes);

    // Go: hashFileEntry -> "FILE:path:size:fileRoot"
    const rawFile = \`FILE:\${path}:\${fileInfo.file_size}:\${fileRoot}\`;
    fileLeafHashes.push(sha256(rawFile));
}

// 全ファイルをパス順にソートして最終ルートを計算
const siteRoot = calculateMerkleRoot(fileLeafHashes);
process.stdout.write(siteRoot);
EOF
)

echo "   > 再計算された SiteRoot : $CALCULATED_SITE_ROOT"
echo "   > マニフェスト記録値   : $EXPECTED_SITE_ROOT"

if [ "$CALCULATED_SITE_ROOT" == "$EXPECTED_SITE_ROOT" ]; then
    echo ""
    echo "===================================================================="
    echo "🎉 【検証結果：合格】 データの完全性が数学的に証明されました！"
    echo "===================================================================="
    echo "1. 断片ハッシュ一致: ストレージに保存された実データは、目録と一致します。"
    echo "2. 木構造の正当性: データの分割順序と構造は、GWCの計算通りです。"
    echo "3. 公証値の一致: SiteRoot は改ざんされておらず、信頼できる証跡です。"
else
    echo ""
    echo "❌ 【検証結果：不合格】 SiteRoot が一致しません。"
    echo "計算ロジックを再確認してください。"
    exit 1
fi