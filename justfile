# justfile for raidchain project

# --- 変数定義 ---
HELM_RELEASE_NAME := "raidchain"
NAMESPACE         := "raidchain"
IMAGE_FDSC        := "raidchain/fdsc:latest"
IMAGE_MDSC        := "raidchain/mdsc:latest"
IMAGE_GWC         := "raidchain/gwc:latest"
IMAGE_RELAYER     := "raidchain/relayer:latest"
DEFAULT_CHAINS    := "2"

# justコマンドのデフォルトの挙動を設定。コマンド一覧を表示する。
default:
    @just --list

# --- Workflow ---

# [一括実行] クリーンアップ、再生成、ビルド、デプロイを全て実行
all-in-one chains=DEFAULT_CHAINS:
    @just clean-all
    @just scaffold-chain
    @just build
    @just deploy-clean {{chains}}
    @echo "✅ All-in-one process complete!"

# --- Build Tasks ---

# [推奨] 全てのコンポーネントをビルド
build: build-fdsc build-mdsc build-gwc build-relayer
    @echo "✅ All images built."

# FDSC (FragmentData Storage Chain) のDockerイメージをビルド
build-fdsc:
    @echo "🏗️  Building FDSC..."
    @ignite chain build --path ./chain/fdsc -o dist --skip-proto
    @docker build -t {{IMAGE_FDSC}} -f build/fdsc/Dockerfile .

# MDSC (ManifestData Storage Chain) のDockerイメージをビルド
build-mdsc:
    @echo "🏗️  Building MDSC..."
    @ignite chain build --path ./chain/mdsc -o dist --skip-proto
    @docker build -t {{IMAGE_MDSC}} -f build/mdsc/Dockerfile .

# GWC (Gateway Chain) のDockerイメージをビルド
build-gwc:
    @echo "🏗️  Building GWC..."
    @ignite chain build --path ./chain/gwc -o dist --skip-proto
    @docker build -t {{IMAGE_GWC}} -f build/gwc/Dockerfile .

# relayerのDockerイメージをビルド
build-relayer:
    @echo "🏗️  Building Relayer..."
    @docker build -t {{IMAGE_RELAYER}} -f build/relayer/Dockerfile .

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
    @-helm uninstall {{HELM_RELEASE_NAME}} --namespace {{NAMESPACE}}
    @echo "--> 🗑️ Deleting Persistent Volume Claims..."
    @-kubectl -n {{NAMESPACE}} delete pvc -l app.kubernetes.io/name={{HELM_RELEASE_NAME}}

# K8sリソースをクリーンアップしてからデプロイ
# 例: just deploy-clean 4
deploy-clean chains=DEFAULT_CHAINS:
    @just clean-k8s
    @just deploy {{chains}}
    @echo "✅ Redeployment complete!"

upgrade:
    @helm upgrade {{HELM_RELEASE_NAME}} k8s/helm/raidchain --namespace {{NAMESPACE}} --reuse-values

# --- Logging and Exec ---

# [デフォルト] 全コンポーネントのログを表示
logs: logs-all

# 全てのコンポーネントのログを表示
logs-all:
    @kubectl logs -f -l app.kubernetes.io/instance={{HELM_RELEASE_NAME}} -n {{NAMESPACE}} --max-log-requests=15

# FDSC Podのログを表示
logs-fdsc:
    @kubectl logs -f -l app.kubernetes.io/instance={{HELM_RELEASE_NAME}},app.kubernetes.io/name=fdsc -n {{NAMESPACE}}

# MDSC Podのログを表示
logs-mdsc:
    @kubectl logs -f -l app.kubernetes.io/instance={{HELM_RELEASE_NAME}},app.kubernetes.io/name=mdsc -n {{NAMESPACE}}

# GWC Podのログを表示
logs-gwc:
    @kubectl logs -f -l app.kubernetes.io/instance={{HELM_RELEASE_NAME}},app.kubernetes.io/name=gwc -n {{NAMESPACE}}

# --- Development Tasks ---

# チェーンの動作確認テストを実行
test:
    @./scripts/test/chain-integrity-test.sh

# 新しいチェーンのひな形を生成 (3種類すべて)
scaffold-chain:
    @just scaffold-fdsc
    @just scaffold-mdsc
    @just scaffold-gwc
    @echo "✅ Scaffold complete! Check the 'chain' directory."

scaffold-fdsc:
    @./scripts/scaffold/scaffold-chain.sh fdsc datastore

scaffold-mdsc:
    @./scripts/scaffold/scaffold-chain.sh mdsc metastore

scaffold-gwc:
    @./scripts/scaffold/scaffold-chain.sh gwc gateway

# --- Cleanup Tasks ---

# K8sリソースを削除し、生成されたディレクトリも削除
clean-all: clean-k8s clean-chain
    @echo "✅ Full cleanup complete!"

clean-chain:
    @echo "--> 🗑️ Deleting generated chain directories..."
    @rm -rf chain/fdsc chain/mdsc chain/gwc

# K8sリソース(Namespaceごと)を削除
clean-k8s: undeploy
    @echo "--> 🗑️ Deleting namespace {{NAMESPACE}}..."
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