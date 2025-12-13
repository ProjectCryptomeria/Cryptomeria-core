# --- 変数定義 ---
PROJECT_NAME := "cryptomeria"
DEFAULT_CHAINS    := "2"

# justコマンドのデフォルトの挙動を設定。コマンド一覧を表示する。
default:
    @just --list

# --- Workflow ---

# [一括実行] クリーンアップ、再生成、ビルド、デプロイを全て実行
all-in-one chains=DEFAULT_CHAINS:
    @just clean-k8s
    @just build-all
    @just deploy {{chains}}
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

# [高速開発用] バイナリをビルド・転送・再起動 (検証機能付き)
hot-reload target:
    #!/usr/bin/env bash
    set -e
    echo "🔥 Hot reloading {{target}}..."
    
    # 1. Igniteでビルド (generateも念のため実行)
    echo "    Generating proto and compiling binary..."
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
    echo "    📦 Local Binary Hash: $LOCAL_HASH"

    # 2. 実行中のPodを特定
    echo "    Injecting binary into Pod..."
    POD=$(kubectl get pod -n {{PROJECT_NAME}} -l app.kubernetes.io/component={{target}} -o jsonpath="{.items[0].metadata.name}")
    
    if [ -z "$POD" ]; then
        echo "❌ Error: Pod for {{target}} not found in namespace {{PROJECT_NAME}}."
        exit 1
    fi
    echo "    Target Pod: $POD"

    # 3. 新しいバイナリを転送
    kubectl cp "$LOCAL_BINARY" {{PROJECT_NAME}}/$POD:/tmp/"$BINARY_NAME"_new
    
    # 4. コンテナ内で検証・置換・再起動
    echo "    Verifying and restarting process..."
    kubectl exec -n {{PROJECT_NAME}} $POD -- /bin/bash -c "
        set -e
        # 転送されたファイルのハッシュ確認
        REMOTE_HASH=\$(md5sum /tmp/${BINARY_NAME}_new | awk '{print \$1}')
        echo \"    📦 Remote Binary Hash (New): \$REMOTE_HASH\"
        
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
        
        # 再起動後の PID取得
        NEW_PID=\$(pgrep -x $BINARY_NAME || echo '')
        
        echo \"    🔄 PID Change: \$OLD_PID -> \$NEW_PID\"
        
        if [ \"\$OLD_PID\" == \"\$NEW_PID\" ] && [ -n \"\$OLD_PID\" ]; then
            echo \"⚠️ Warning: PID did not change. Process might not have restarted correctly.\"
        else
            echo \"✅ Process restarted successfully.\"
        fi
    "
    echo "✅ {{target}} reloaded!"

# --- Build Tasks ---

# [一括] 全てのコンポーネントをビルド (並列実行)
# build-all コマンド
build-all:
    #!/usr/bin/env bash
    set -e # エラーが発生したら即座に停止させる（安全のため）

    echo "--- Building gwc, fdsc, mdsc in parallel ---"
    # 末尾に & をつけることでバックグラウンド（並列）で実行
    just build gwc &
    just build fdsc &
    just build mdsc &

    # バックグラウンドのジョブが全て完了するのを待つ
    wait

    echo "--- All dependencies built. Building relayer ---"
    # ここに到達した時点で gwc (gwcd) の生成は完了している
    just build relayer
    echo "✅ All components built successfully."

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
        echo "    Allowed: fdsc, mdsc, gwc"
        exit 1
    fi

    echo "🏗️  Compiling binary for {{target}}..."
    cd apps/{{target}} && ignite chain build -o dist/ --skip-proto
    echo "✅ Binary compiled: dist/{{target}}d"

# [ステップ2] Dockerイメージをビルドする
# 使用例: just build-image fdsc
build-image target:
    #!/usr/bin/env bash
    set -e
    BASE_DIR=$(pwd)
    # ターゲットの検証 (Relayerも含む)
    if [[ ! "{{target}}" =~ ^(fdsc|mdsc|gwc|relayer)$ ]]; then
        echo "❌ Error: Target '{{target}}' is unknown."
        echo "    Allowed: fdsc, mdsc, gwc, relayer"
        exit 1
    fi

    echo "🐳 Building Docker image for {{target}}..."
    TARGET_DIR="apps/{{target}}"
    DOCKERFILE="apps/{{target}}/Dockerfile"
    if [ ! -f "$DOCKERFILE" ]; then
        echo "❌ Error: Dockerfile not found at $DOCKERFILE"
        exit 1
    fi

    # --- Relayer用の事前準備 ---
    if [ "{{target}}" == "relayer" ]; then
        echo "    -> Copying gwcd binary to relayer context..."
        # gwcのバイナリが存在するか確認
        if [ ! -f "apps/gwc/dist/gwcd" ]; then
             echo "❌ Error: gwcd binary not found at apps/gwc/dist/gwcd."
             echo "    Please run 'just build-chain gwc' first."
             exit 1
        fi
        # バイナリをビルドコンテキスト内にコピー
        cp "apps/gwc/dist/gwcd" "$TARGET_DIR/gwcd"
    fi
    # --- 【追加ここまで】 ---

    cd "$TARGET_DIR"
    docker build -t "{{PROJECT_NAME}}/{{target}}:latest" -f "./Dockerfile" .
    
    # --- 事後処理 ---
    if [ "{{target}}" == "relayer" ]; then
        rm gwcd
    fi

    echo "✅ Image built: {{PROJECT_NAME}}/{{target}}:latest"
    cd "$BASE_DIR"

# --- Kubernetes Tasks ---

# Helmを使い、Kubernetesクラスタにデプロイ (FDSCの数を指定可能)
# 例: just deploy 4
deploy chains=DEFAULT_CHAINS:
    #!/usr/bin/env sh
    set -e
    OPS_HELM_CHART_DIR="./ops/infra/k8s/helm/{{PROJECT_NAME}}"
    
    echo "--> 🚀 Deploying with {{chains}} FDSC node(s)..."
    
    # generate-values.sh の実行を廃止し、fdsc.replicas に直接値をセット
    helm dependency update "$OPS_HELM_CHART_DIR"
    
    helm install {{PROJECT_NAME}} "$OPS_HELM_CHART_DIR" \
        --namespace {{PROJECT_NAME}} \
        --create-namespace \
        --set fdsc.replicas={{chains}} \
        --timeout 10m

# デプロイされたアプリケーションと関連PVCをクラスタからアンインストール
undeploy:
    @echo "--> 🛑 Uninstalling Helm release..."
    @# --wait を追加: リソースが解放されるのを待ってから次に進む
    @-helm uninstall {{PROJECT_NAME}} --namespace {{PROJECT_NAME}} --wait
    
    @echo "--> 🗑️ Deleting Persistent Volume Claims (Data)..."
    @# PVC（データ）を削除。これでチェーンの状態はリセットされます
    @-kubectl -n {{PROJECT_NAME}} delete pvc -l app.kubernetes.io/name={{PROJECT_NAME}}
    
    @echo "--> 🧹 Cleaning up stray Jobs..."
    @# Helmで管理しきれていないJobが残ることがあるので念のため削除
    @-kubectl -n {{PROJECT_NAME}} delete jobs --all

    @echo "--> 🗑️ Deleting Stale Secrets (Mnemonics)..."
    @# 前回のエラー対応として、ニーモニックSecretを削除
    @-kubectl delete secret cryptomeria-mnemonics -n {{PROJECT_NAME}} --ignore-not-found

# [高速化] Namespaceは残したまま、リソースとデータだけリセットして再デプロイ
# 例: just deploy-clean 4
deploy-clean chains=DEFAULT_CHAINS:
    @just undeploy
    @just deploy {{chains}}
    @echo "✅ Redeployment complete (Namespace preserved)!"

# [更新] Helmリリースを更新し、指定したターゲット(または全て)を再起動
# データ（ブロックチェーンの状態）は維持されます。
# 使用例: just upgrade fdsc
upgrade target="all" chains=DEFAULT_CHAINS:
    #!/usr/bin/env bash
    set -e
    PROJECT_NAME="{{PROJECT_NAME}}"
    OPS_HELM_CHART_DIR="ops/infra/k8s/helm/$PROJECT_NAME"
        
    # 1. ビルド (変更があった場合のため)
    if [ "{{target}}" == "all" ]; then
        echo "🏗️  Building all images..."
        just build-image-all
    else
        echo "🏗️  Building image for {{target}}..."
        just build-image {{target}}
    fi

    echo "--> ♻️  Upgrading Helm release (Target: {{target}})..."
    # Helm upgradeを実行 (構成変更があれば適用、なければConfigMap等の更新トリガー)
    helm upgrade $PROJECT_NAME $OPS_HELM_CHART_DIR \
        --namespace $PROJECT_NAME \
        --set fdsc.replicas={{chains}} # <-- 動的なレプリカ数を上書き
    
    # 3. Podの再起動 (imagePullPolicy: Always または latestタグの再取得、Config反映のため)
    if [ "{{target}}" == "all" ]; then
        echo "--> 🔄 Restarting all statefulsets and deployments..."
        kubectl -n {{PROJECT_NAME}} rollout restart statefulset
        kubectl -n {{PROJECT_NAME}} rollout restart deployment
    elif [ "{{target}}" == "relayer" ]; then
        echo "--> 🔄 Restarting relayer..."
        kubectl -n {{PROJECT_NAME}} rollout restart deployment -l app.kubernetes.io/component=relayer
    else
        # ターゲット名からコンポーネントラベルへ変換
        COMPONENT=""
        case "{{target}}" in
            fdsc) COMPONENT="datastore" ;;
            mdsc) COMPONENT="metastore" ;;
            gwc)  COMPONENT="gateway" ;;
            *)    
                echo "⚠️  Unknown target '{{target}}', trying to restart by name..."
                COMPONENT="{{target}}" 
                ;;
        esac
        
        echo "--> 🔄 Restarting statefulsets for component: $COMPONENT"
        # componentラベルが一致するStatefulSetを再起動
        kubectl -n {{PROJECT_NAME}} rollout restart statefulset -l app.kubernetes.io/component=$COMPONENT
    fi

    echo "✅ Upgrade complete!"

template:
    @helm template {{PROJECT_NAME}} ops/infra/k8s/helm/{{PROJECT_NAME}} -n {{PROJECT_NAME}} --set fdsc.replicas=2

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
    @echo "--> 🗑️ Deleting namespace {{PROJECT_NAME}} (This may take a while)..."
    @kubectl delete namespace {{PROJECT_NAME}} --ignore-not-found

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