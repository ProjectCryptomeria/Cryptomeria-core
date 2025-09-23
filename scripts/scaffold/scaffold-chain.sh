#!/bin/bash
set -e

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
            # metachain: 「雛形生成 → .protoファイル上書き → コード再生成」の自動化フロー
            echo "  ➡️  Step 1/3: Scaffolding templates..."
            # Step 1-1: `map`の値となる `ChunkList` 型の雛形を生成
            ignite scaffold type ChunkList hashes:array.string --module "$MODULE_NAME" --no-message

            # Step 1-2: `Manifest` Mapストアの雛形を生成 (値の型は仮で`ChunkList`を指定)
            ignite scaffold map Manifest url:string manifest:ChunkList --module "$MODULE_NAME" --signer creator

            echo "  ➡️  Step 2/3: Overwriting .proto file with the correct map structure..."
            # Step 2: manifest.proto を修正し、ChunkListをimportしてmapの型として利用する
            PROTO_FILE="proto/${CHAIN_NAME}/${MODULE_NAME}/v1/manifest.proto"
            
            # heredocを使ってファイル全体を正確に上書き
            cat <<EOF > "$PROTO_FILE"
syntax = "proto3";

package ${CHAIN_NAME}.${MODULE_NAME}.v1;

import "gogoproto/gogo.proto";
// 外部ファイルで定義されたChunkListをインポートする
import "${CHAIN_NAME}/${MODULE_NAME}/v1/chunk_list.proto";

option go_package = "${CHAIN_NAME}/x/${MODULE_NAME}/types";

// Manifest is the main message that holds the manifest data for a given URL.
message Manifest {
  string creator = 1;
  string url = 2;
  // The 'manifest' field maps a file path (e.g., "/index.html") to its list of chunk hashes.
  map<string, ChunkList> manifest = 3;
}
EOF
            echo "  ➡️  Step 3/3: Regenerating Go code from the modified .proto file..."
            # Step 3: 編集した.protoファイルを元にGoのコードを再生成
            ignite generate proto-go

            ;;
        *)
            echo "💥 Error: Unknown chain name '$CHAIN_NAME'."
            exit 1
            ;;
    esac
    
    # IBCバージョンを書き換える
    sed -i "s/${CHAIN_NAME}-1/${RELEASE_NAME}-1/g" "x/${MODULE_NAME}/types/types.go"
    
    cd ../..
    echo "✅  $CHAIN_NAME source code scaffolded in '$CHAIN_DIR'"
fi