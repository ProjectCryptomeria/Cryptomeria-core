#!/bin/bash
set -e

# 必要であればインストール（環境に合わせてコメントアウト等してください）
# go install github.com/bufbuild/buf/cmd/buf@v1.28.1

# ディレクトリ定義
ROOT_DIR=$(pwd)
SERVICE_DIR="services/upload_page"
GWC_DIR="apps/gwc"
TEMP_PROTO_DIR="${SERVICE_DIR}/proto_temp"
OUTPUT_DIR="${SERVICE_DIR}/src/lib/proto"

# プロジェクトルートからの実行を想定してディレクトリ移動
if [ -d "scripts" ] && [ -f "package.json" ]; then
    cd ../.. 
fi

echo "🚀 Generating TypeScript proto files..."
echo "📂 Working directory: $(pwd)"

# 1. 一時ディレクトリのクリーンアップと作成
rm -rf "${TEMP_PROTO_DIR}"
mkdir -p "${TEMP_PROTO_DIR}"
mkdir -p "${OUTPUT_DIR}"

# 2. Protoファイルのコピー
echo "📦 Copying proto files from ${GWC_DIR}..."

# 【修正1】protoディレクトリ"自体"ではなく、その"中身"(*)を直下にコピーします。
# これにより、TEMP_PROTO_DIR が直接のインポートルート（gwc/gateway/... の親）になります。
cp -r "${GWC_DIR}/proto/"* "${TEMP_PROTO_DIR}/"

# 3. buf.yaml (v1) の生成
echo "📄 Creating temporary buf.yaml (v1)..."

# 【修正2】 'build: roots:' セクションを削除しました。
# コピー方法を変更したため、カレントディレクトリがそのままルートとして認識されます。
cat <<EOF > "${TEMP_PROTO_DIR}/buf.yaml"
version: v1
deps:
  - buf.build/cosmos/cosmos-proto
  - buf.build/cosmos/cosmos-sdk
  - buf.build/cosmos/gogo-proto
  - buf.build/cosmos/ics23
  - buf.build/googleapis/googleapis
  - buf.build/protocolbuffers/wellknowntypes
  - buf.build/cosmos/ibc
EOF

# 4. Buf Generate の実行
echo "🛠 Running buf generate..."
cd "${TEMP_PROTO_DIR}"

# 依存関係の解決
buf mod update

# 生成実行
buf generate --template "../buf.gen.yaml" --output "../src/lib/proto"

# 5. 後始末
cd "${ROOT_DIR}"
rm -rf "${TEMP_PROTO_DIR}"

echo "✅ Proto generation complete!"