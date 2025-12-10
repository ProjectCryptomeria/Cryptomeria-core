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
RELEASE_NAME=${3:-cryptomeria}

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
        --path "./$CHAIN_DIR" \
        # --skip-proto 


    cd "$CHAIN_DIR"

    # echo -e "version: v2\nplugins: []" > ./proto/buf.gen.swagger.yaml
    
    # 共通処理(2): モジュールを生成
    ignite scaffold module --ibc "$MODULE_NAME" --dep bank --yes
    
    # 固有処理: チェーン名に応じてデータ構造とクエリの定義を分岐
    echo "🧬  Scaffolding specific data structures and queries for $CHAIN_NAME..."
    case "$CHAIN_NAME" in
        "fdsc")
            # FDSC: FragmentData Storage Chain (旧 datachain)
            # Key: fragment_id (ハッシュ), Value: data (バイナリ)
            ignite scaffold map fragment data:bytes \
                --module "$MODULE_NAME" \
                --index fragment_id:string \
                --signer creator \
                --yes
            ;;
        "mdsc")
            # MDSC: ManifestData Storage Chain (旧 metachain)
            # Key: project_name, Value: version (Manifestの核となる情報)
            ignite scaffold map manifest version:string \
                --module "$MODULE_NAME" \
                --index project_name:string \
                --signer creator \
                --yes
            ;;
        "gwc")
            # GWC: Gateway Chain (旧 gatewaychain)
            # GWCは揮発性（Strict Pruning）運用のため、永続的なストレージは定義しません。
            echo "ℹ️  Gateway Chain (GWC) is configured as ephemeral. Skipping data structure scaffold."
            ;;
        *)
            echo "💥 Error: Unknown chain name '$CHAIN_NAME'. Must be 'fdsc', 'mdsc', or 'gwc'."
            exit 1
            ;;
    esac
    
 
    # IBCバージョンを書き換える
    sed -i "s/${MODULE_NAME}-1/${RELEASE_NAME}-1/g" "x/${MODULE_NAME}/types/keys.go"
    
    cd ../..
    echo "✅  $CHAIN_NAME source code scaffolded in '$CHAIN_DIR'"
fi