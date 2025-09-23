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
          # metachain: マニフェスト方式のデータ構造を段階的に定義

            # Step 1: repeated string のラッパーとして ChunkList メッセージを定義
            ignite scaffold message ChunkList hashes:array.string \
                --module "$MODULE_NAME" \
                --no-simulation \
                --yes

            # Step 2: file path -> ChunkList のマップを持つ ManifestData メッセージを定義
            ignite scaffold message ManifestData files:map.string.ChunkList \
                --module "$MODULE_NAME" \
                --no-simulation \
                --signer creator \
                --yes
            
            # Step 3: url -> ManifestData のトップレベルMapを定義
            ignite scaffold map Manifest url:string manifestData:ManifestData \
                --module "$MODULE_NAME" \
                --signer creator \
                --no-simulation \
                --yes
            ;;
        *)
            echo "💥 Error: Unknown chain name '$CHAIN_NAME'."
            exit 1
            ;;
    esac
    
    # IBCバージョンを書き換える
    sed -i "s/${CHAIN_NAME}-1/raidchain-1/g" "x/${MODULE_NAME}/types/types.go"    
    cd ../..
    echo "✅  $CHAIN_NAME source code scaffolded in '$CHAIN_DIR'"
fi
