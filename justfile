# justfile for raidchain project

# --- 変数定義 ---
HELM_RELEASE_NAME := "raidchain"
NAMESPACE         := "raidchain"
DEFAULT_CHAINS    := "2"

# justコマンドのデフォルトの挙動を設定。コマンド一覧を表示する。
default:
    @just --list

# --- Workflow ---

# [一括実行] クリーンアップ、再生成、ビルド、デプロイを全て実行
all-in-one chains=DEFAULT_CHAINS:
    @just clean-k8s
    @just build
    @just deploy-clean {{chains}}
    @echo "✅ All-in-one process complete!"

# --- Go-Generated Tasks ---
[parallel]
generate-all: (generate 'fdsc') (generate 'mdsc') (generate 'gwc')
    @echo "✅ All code generation complete!"

generate target:
    @echo "🔧 Generating code for {{uppercase(target)}}..."
    @cd chain/{{target}} && ignite generate proto-go
    @echo "✅ {{uppercase(target)}} code generation complete!"


# --- Fast Update Tasks ---
[parallel]
hot-reload-all: (hot-reload 'fdsc') (hot-reload 'mdsc') (hot-reload 'gwc')
    @echo "✅ Hot reload for all components complete!"

# --- Fast Update Tasks ---

# [高速開発用] バイナリをビルド・転送・再起動 (検証機能付き)
hot-reload target:
    #!/usr/bin/env bash
    set -e
    echo "🔥 Hot reloading {{target}}..."
    
    # 1. Igniteでビルド (generateも念のため実行)
    echo "   Generating proto and compiling binary..."
    just generate {{target}}
    just build-chain {{target}}
    
    BINARY_NAME="{{target}}d"
    LOCAL_BINARY="dist/$BINARY_NAME"
    
    # ローカルのハッシュ値を確認
    if command -v md5sum >/dev/null; then
        LOCAL_HASH=$(md5sum "$LOCAL_BINARY" | awk '{print $1}')
    else
        LOCAL_HASH=$(md5sum "$LOCAL_BINARY" | awk '{print $4}') # Macの場合
    fi
    echo "   📦 Local Binary Hash: $LOCAL_HASH"

    # 2. 実行中のPodを特定
    echo "   Injecting binary into Pod..."
    POD=$(kubectl get pod -n {{NAMESPACE}} -l app.kubernetes.io/component={{target}} -o jsonpath="{.items[0].metadata.name}")
    
    if [ -z "$POD" ]; then
        echo "❌ Error: Pod for {{target}} not found in namespace {{NAMESPACE}}."
        exit 1
    fi
    echo "   Target Pod: $POD"

    # 3. 新しいバイナリを転送
    kubectl cp "$LOCAL_BINARY" {{NAMESPACE}}/$POD:/tmp/"$BINARY_NAME"_new
    
    # 4. コンテナ内で検証・置換・再起動
    echo "   Verifying and restarting process..."
    kubectl exec -n {{NAMESPACE}} $POD -- /bin/bash -c "
        set -e
        # 転送されたファイルのハッシュ確認
        REMOTE_HASH=\$(md5sum /tmp/${BINARY_NAME}_new | awk '{print \$1}')
        echo \"   📦 Remote Binary Hash (New): \$REMOTE_HASH\"
        
        if [ \"$LOCAL_HASH\" != \"\$REMOTE_HASH\" ]; then
            echo \"❌ Hash mismatch! Copy failed.\"
            exit 1
        fi

        # バイナリの差し替え
        mv /tmp/${BINARY_NAME}_new /home/{{target}}/bin/$BINARY_NAME
        chmod +x /home/{{target}}/bin/$BINARY_NAME
        
        # 再起動前のPID取得
        OLD_PID=\$(pgrep -x $BINARY_NAME || echo '')
        
        # プロセス停止
        killall $BINARY_NAME
        
        # 再起動待ち (entrypointのループが再起動するのを待つ)
        sleep 2
        
        # 再起動後のPID取得
        NEW_PID=\$(pgrep -x $BINARY_NAME || echo '')
        
        echo \"   🔄 PID Change: \$OLD_PID -> \$NEW_PID\"
        
        if [ \"\$OLD_PID\" == \"\$NEW_PID\" ] && [ -n \"\$OLD_PID\" ]; then
            echo \"⚠️ Warning: PID did not change. Process might not have restarted correctly.\"
        else
            echo \"✅ Process restarted successfully.\"
        fi
    "
    echo "✅ {{target}} reloaded!"

# --- Build Tasks ---

# [一括] 全てのコンポーネントをビルド (並列実行)
[parallel]
build-all: (build 'fdsc') (build 'mdsc') (build 'gwc') (build 'relayer')
    @echo "✅ All components built successfully."

# [一括] 全てのチェーンバイナリをビルド (並列実行)
[parallel]
build-chain-all: (build-chain 'fdsc') (build-chain 'mdsc') (build-chain 'gwc')
    @echo "✅ All chain binaries compiled successfully."

# [一括] 全てのDockerイメージをビルド (並列実行)
[parallel]
build-image-all: (build-image 'fdsc') (build-image 'mdsc') (build-image 'gwc') (build-image 'relayer')
    @echo "✅ All Docker images built successfully."

# [統合] 特定のターゲットのバイナリ作成とDockerイメージ作成を一括で行う
# 使用例: just build fdsc
build target:
    #!/usr/bin/env bash
    set -e
    # Relayerはバイナリコンパイル不要（Dockerfile内で完結する場合）または別手順のためスキップ
    if [ "{{target}}" != "relayer" ]; then
        just build-chain {{target}}
    fi
    just build-image {{target}}

# [ステップ1] Igniteを使ってチェーンのバイナリをコンパイルする
# 使用例: just compile-binary fdsc
build-chain target:
    #!/usr/bin/env bash
    set -e
    # ターゲットの検証
    if [[ ! "{{target}}" =~ ^(fdsc|mdsc|gwc)$ ]]; then
        echo "❌ Error: Target '{{target}}' is not a valid chain project."
        echo "   Allowed: fdsc, mdsc, gwc"
        exit 1
    fi

    echo "🏗️  Compiling binary for {{target}}..."
    cd chain/{{target}} && ignite chain build -o ../../dist --skip-proto
    echo "✅ Binary compiled: dist/{{target}}d"

# [ステップ2] Dockerイメージをビルドする
# 使用例: just build-image fdsc
build-image target:
    #!/usr/bin/env bash
    set -e
    # ターゲットの検証 (Relayerも含む)
    if [[ ! "{{target}}" =~ ^(fdsc|mdsc|gwc|relayer)$ ]]; then
        echo "❌ Error: Target '{{target}}' is unknown."
        echo "   Allowed: fdsc, mdsc, gwc, relayer"
        exit 1
    fi

    echo "🐳 Building Docker image for {{target}}..."
    
    # Dockerfileの存在確認
    DOCKERFILE="build/{{target}}/Dockerfile"
    if [ ! -f "$DOCKERFILE" ]; then
        echo "❌ Error: Dockerfile not found at $DOCKERFILE"
        exit 1
    fi

    docker build -t "raidchain/{{target}}:latest" -f "$DOCKERFILE" .
    echo "✅ Image built: raidchain/{{target}}:latest"

# --- Kubernetes Tasks ---

# Helmを使い、Kubernetesクラスタにデプロイ (FDSCの数を指定可能)
# 例: just deploy 4
deploy chains=DEFAULT_CHAINS:
    #!/usr/bin/env sh
    set -e
    echo "--> 🚀 Deploying with {{chains}} FDSC node(s)..."
    TEMP_VALUES_FILE=".helm-temp-values.yaml"
    trap 'rm -f -- "$TEMP_VALUES_FILE"' EXIT
    ./scripts/helm/generate-values.sh {{chains}} > "$TEMP_VALUES_FILE"
    helm dependency update k8s/helm/raidchain
    helm install {{HELM_RELEASE_NAME}} k8s/helm/raidchain \
        --namespace {{NAMESPACE}} \
        --create-namespace \
        -f "$TEMP_VALUES_FILE"

# デプロイされたアプリケーションと関連PVCをクラスタからアンインストール
undeploy:
    @echo "--> 🛑 Uninstalling Helm release..."
    @# --wait を追加: リソースが解放されるのを待ってから次に進む
    @-helm uninstall {{HELM_RELEASE_NAME}} --namespace {{NAMESPACE}} --wait
    
    @echo "--> 🗑️ Deleting Persistent Volume Claims (Data)..."
    @# PVC（データ）を削除。これでチェーンの状態はリセットされます
    @-kubectl -n {{NAMESPACE}} delete pvc -l app.kubernetes.io/name={{HELM_RELEASE_NAME}}
    
    @echo "--> 🧹 Cleaning up stray Jobs..."
    @# Helmで管理しきれていないJobが残ることがあるので念のため削除
    @-kubectl -n {{NAMESPACE}} delete jobs --all

# [高速化] Namespaceは残したまま、リソースとデータだけリセットして再デプロイ
# 例: just deploy-clean 4
deploy-clean chains=DEFAULT_CHAINS:
    @just undeploy
    @just deploy {{chains}}
    @echo "✅ Redeployment complete (Namespace preserved)!"

# データ（ブロックチェーンの状態）は維持したまま、バイナリや設定だけ更新
update:
    @echo "--> ♻️ Updating Helm release (Preserving data)..."
    @helm upgrade {{HELM_RELEASE_NAME}} k8s/helm/raidchain --namespace {{NAMESPACE}}
    @kubectl -n {{NAMESPACE}} rollout restart statefulset
    @echo "✅ Update complete! Chain data preserved."

# --- Development Tasks ---
[parallel]
scaffold-all: (scaffold 'fdsc') (scaffold 'mdsc') (scaffold 'gwc')
    @echo "✅ Scaffold complete! Check the 'chain' directory."

# 新しいチェーンのひな形を生成 
scaffold target:
    @just scaffold-{{target}}
    @echo "✅ Scaffold complete! Check the 'chain' directory."

scaffold-fdsc:
    @./scripts/scaffold/scaffold-chain.sh fdsc datastore

scaffold-mdsc:
    @./scripts/scaffold/scaffold-chain.sh mdsc metastore

scaffold-gwc:
    @./scripts/scaffold/scaffold-chain.sh gwc gateway

# --- Cleanup Tasks ---

# Namespaceごと完全に消し去る（時間がかかるので非常時や終了時用）
clean-k8s: undeploy
    @echo "--> 🗑️ Deleting namespace {{NAMESPACE}} (This may take a while)..."
    @kubectl delete namespace {{NAMESPACE}} --ignore-not-found

# --- Controller Tasks ---

# [コントローラー] 依存パッケージをインストール
ctl-install:
    @cd controller && yarn install

# [コントローラー] パッケージを追加
ctl-add *args:
    @cd controller && yarn add {{args}}

# [コントローラー] パッケージを削除
ctl-rmv *args:
    @cd controller && yarn remove {{args}}

# [コントローラー] 開発サーバーを起動
ctl-dev:
    @cd controller && yarn start

# [コントローラー] コマンドを実行 (汎用)
ctl-exec *args:
    @cd controller && yarn {{args}}

# [コントローラー] 実験を実行
ctl-exp:
    @cd controller && yarn ts-node src/scripts/interactive-runner.ts

ctl-monitor:
    @cd controller && yarn ts-node src/scripts/monitor-chain.ts

# --- Test Tasks ---

test process:
    @echo "--> 🧪 Running {{process}}-test process..."
    @just {{process}}-test
    @echo "✅ process complete!"

upload-test:
    @echo "--> 📤 Uploading test data..."
    @./scripts/test/poc-upload-test.sh
    @echo "✅ Test data upload complete!"

download-test:
    @echo "--> 📥 Downloading test data..."
    @./scripts/test/poc-download-test.sh
    @echo "✅ Test data download complete!"