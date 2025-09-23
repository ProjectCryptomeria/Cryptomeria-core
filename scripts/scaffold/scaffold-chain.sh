#!/bin/bash
set -e
# Goモジュールのキャッシュディレクトリを設定し、ダウンロード時間を短縮
export GOMODCACHE=${GOMODCACHE:-/tmp/gomodcache}
mkdir -p $GOMODCACHE

# --- 引数のチェック ---
if [ -z "$1" ] || [ -z "$2" ]; then
    echo "💥 Error: Missing arguments."
    echo "Usage: $0 <chain-name> <module-name>"
    exit 1
fi

# --- 変数定義 ---
CHAIN_NAME=$1
MODULE_NAME=$2
CHAIN_DIR="chain/${CHAIN_NAME}"
RELEASE_NAME=${3:-raidchain}

# --- メイン処理 ---
if [ -d "$CHAIN_DIR" ]; then
    echo "ℹ️  '$CHAIN_DIR' directory already exists. Skipping scaffold."
else
    echo "🏗️  Scaffolding $CHAIN_NAME source code..."
    
    # 共通処理(1): チェーンの基本骨格を生成
    ignite scaffold chain "$CHAIN_NAME" \
        --no-module \
        --skip-git \
        --default-denom uatom \
        --path "./$CHAIN_DIR"


    cd "$CHAIN_DIR"

    echo -e "version: v2\nplugins: []" > ./proto/buf.gen.swagger.yaml
    
    # 共通処理(2): モジュールを生成
    ignite scaffold module --ibc "$MODULE_NAME" --dep bank --yes
    
    # 固有処理: チェーン名に応じてデータ構造の定義を分岐
    echo "🧬  Scaffolding specific data structures for $CHAIN_NAME..."
    case "$CHAIN_NAME" in
        "datachain")
            # datachain: index(string)をキーとするKVSを定義
            ignite scaffold map storedChunk data:bytes \
                --module "$MODULE_NAME" \
                --index index:string \
                --signer creator \
                --yes
            ;;
        "metachain")
            # metachain: 「雛形生成 → .protoファイル自動修正 → コード再生成」の自動化フロー
            echo "  ➡️  Step 1/4: Scaffolding templates..."
            # Step 1-1: `map`の値となる `ChunkList` 型の雛形を生成
            ignite scaffold type ChunkList hashes:array.string --module "$MODULE_NAME" --no-message

            # Step 1-2: `Manifest` Mapストアの雛形を生成 (値の型は仮で`ChunkList`を指定)
            ignite scaffold map Manifest manifest:ChunkList --module "$MODULE_NAME" --signer creator --index url:string

            echo "  ➡️  Step 2/4: Modifying manifest.proto..."
            # Step 2: manifest.proto内のmanifestフィールドの型を map<string, ChunkList> に置換
            MANIFEST_PROTO="proto/${CHAIN_NAME}/${MODULE_NAME}/v1/manifest.proto"
            sed -i.bak 's/ChunkList manifest/map<string, ChunkList> manifest/g' "$MANIFEST_PROTO"
            rm "${MANIFEST_PROTO}.bak"
            
            echo "  ➡️  Step 3/4: Modifying tx.proto..."
            # Step 3: tx.proto内のMsgCreateManifestとMsgUpdateManifestのmanifestフィールドの型を置換
            TX_PROTO="proto/${CHAIN_NAME}/${MODULE_NAME}/v1/tx.proto"
            sed -i.bak 's/ChunkList manifest/map<string, ChunkList> manifest/g' "$TX_PROTO"
            rm "${TX_PROTO}.bak"

            echo "  ➡️  Step 4/4: Regenerating Go code from modified .proto files..."
            # Step 4: 編集した.protoファイルを元にGoのコードを再生成
            ignite generate proto-go

                ;;
        *)
            echo "💥 Error: Unknown chain name '$CHAIN_NAME'."
            exit 1
            ;;
    esac
    
 
    # IBCバージョンを書き換える
    sed -i "s/${MODULE_NAME}-1/${RELEASE_NAME}-1/g" "x/${MODULE_NAME}/types/keys.go"
    
    cd ../..
    echo "✅  $CHAIN_NAME source code scaffolded in '$CHAIN_DIR'"
fi