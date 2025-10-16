# justfile for raidchain project

# --- 変数定義 ---
RUN_SCRIPT        := "./scripts/make/run.sh"
DEV_IMAGE         := "raidchain/dev-tools:latest"
IGNITE_IMAGE      := "ignitehq/cli:latest"
HELM_RELEASE_NAME := "raidchain"
NAMESPACE         := "raidchain"
IMAGE_DATACHAIN   := "raidchain/datachain:latest"
IMAGE_METACHAIN   := "raidchain/metachain:latest"
IMAGE_RELAYER     := "raidchain/relayer:latest"
DEFAULT_CHAINS    := "7"

# justコマンドのデフォルトの挙動を設定。コマンド一覧を表示する。
default:
    @just --list

# --- Setup Tasks ---

# 開発用の実行環境(dev-tools)イメージをビルド
init-runtime:
    #!/usr/bin/env sh
    DOCKER_GID=$(getent group docker | cut -d: -f3)
    docker build --build-arg DOCKER_GID=${DOCKER_GID} -t {{DEV_IMAGE}} -f develop.Dockerfile .

# --- Workflow ---

# [一括実行] クリーンアップ、再生成、ビルド、デプロイを全て実行
all-in-one chains=DEFAULT_CHAINS:
    @just clean-all
    @just scaffold-chain
    @just build
    @just deploy {{chains}}
    @echo "✅ All-in-one process complete!"

# --- Build Tasks ---

# [推奨] 全てのコンポーネントをビルド
build: build-datachain build-metachain build-relayer
    @echo "✅ All images built."

# datachainのDockerイメージをビルド
build-datachain:
    @{{RUN_SCRIPT}} ignite chain build --path ./chain/datachain -o dist --skip-proto
    @{{RUN_SCRIPT}} docker build -t {{IMAGE_DATACHAIN}} -f build/datachain/Dockerfile .

# metachainのDockerイメージをビルド
build-metachain:
    @{{RUN_SCRIPT}} ignite chain build --path ./chain/metachain -o dist --skip-proto
    @{{RUN_SCRIPT}} docker build -t {{IMAGE_METACHAIN}} -f build/metachain/Dockerfile .

# relayerのDockerイメージをビルド
build-relayer:
    @{{RUN_SCRIPT}} docker build -t {{IMAGE_RELAYER}} -f build/relayer/Dockerfile .

# --- Kubernetes Tasks ---

# Helmを使い、Kubernetesクラスタにデプロイ (datachainの数を指定可能)
# 例: just deploy 4
deploy chains=DEFAULT_CHAINS:
    #!/usr/bin/env sh
    set -e
    echo "--> 🚀 Deploying with {{chains}} datachain(s)..."
    TEMP_VALUES_FILE=".helm-temp-values.yaml"
    trap 'rm -f -- "$TEMP_VALUES_FILE"' EXIT
    ./scripts/helm/generate-values.sh {{chains}} > "$TEMP_VALUES_FILE"
    {{RUN_SCRIPT}} helm dependency update k8s/helm/raidchain
    {{RUN_SCRIPT}} helm install {{HELM_RELEASE_NAME}} k8s/helm/raidchain \
        --namespace {{NAMESPACE}} \
        --create-namespace \
        -f "$TEMP_VALUES_FILE"

# デプロイされたアプリケーションと関連PVCをクラスタからアンインストール
undeploy:
    @-{{RUN_SCRIPT}} helm uninstall {{HELM_RELEASE_NAME}} --namespace {{NAMESPACE}}
    @echo "--> 🗑️ Deleting Persistent Volume Claims..."
    @-{{RUN_SCRIPT}} kubectl -n {{NAMESPACE}} delete pvc -l app.kubernetes.io/name={{HELM_RELEASE_NAME}}

# K8sリソースをクリーンアップしてからデプロイ (datachainの数を指定可能)
# 例: just deploy-clean 4
deploy-clean chains=DEFAULT_CHAINS:
    @just clean-k8s
    @just deploy {{chains}}
    @echo "✅ Redeployment complete!"

upgrade:
    @{{RUN_SCRIPT}} helm upgrade {{HELM_RELEASE_NAME}} k8s/helm/raidchain --namespace {{NAMESPACE}} --reuse-values

# --- Logging and Exec ---

# [デフォルト] datachainのログを表示
logs: logs-datachain

# 全てのコンポーネントのログを表示
logs-all:
    @{{RUN_SCRIPT}} kubectl logs -f -l app.kubernetes.io/instance={{HELM_RELEASE_NAME}} -n {{NAMESPACE}} --max-log-requests=10

# datachain Podのログを表示
logs-datachain:
    @{{RUN_SCRIPT}} kubectl logs -f -l app.kubernetes.io/instance={{HELM_RELEASE_NAME}},app.kubernetes.io/name=datachain -n {{NAMESPACE}}

# metachain Podのログを表示
logs-metachain:
    @{{RUN_SCRIPT}} kubectl logs -f -l app.kubernetes.io/instance={{HELM_RELEASE_NAME}},app.kubernetes.io/name=metachain -n {{NAMESPACE}}

# --- Development Tasks ---

# チェーンの動作確認テストを実行
test:
    @{{RUN_SCRIPT}} ./scripts/test/chain-integrity-test.sh

# 新しいチェーンのひな形を生成
scaffold-chain:
    @just scaffold-datachain
    @just scaffold-metachain
    @echo "✅ Scaffold complete! Check the 'chain' directory."

scaffold-datachain:
    @{{RUN_SCRIPT}} ./scripts/scaffold/scaffold-chain.sh datachain datastore

scaffold-metachain:
    @{{RUN_SCRIPT}} ./scripts/scaffold/scaffold-chain.sh metachain metastore

# --- Cleanup Tasks ---

# K8sリソースを削除し、生成されたディレクトリも削除
clean-all: clean-k8s clean-chain
    @echo "✅ Full cleanup complete!"

clean-chain:
    @echo "--> 🗑️ Deleting generated chain directories from host..."
    @rm -rf chain/datachain chain/metachain

# K8sリソース(Namespaceごと)を削除
clean-k8s: undeploy
    @echo "--> 🗑️ Deleting namespace {{NAMESPACE}}..."
    @{{RUN_SCRIPT}} kubectl delete namespace {{NAMESPACE}} --ignore-not-found

# --- Controller Tasks ---
# [コントローラー] 依存パッケージをインストール
ctl-install:
    @{{RUN_SCRIPT}} bash -c "cd controller && yarn install"

# [コントローラー] 開発サーバーを起動
ctl-dev:
    @{{RUN_SCRIPT}} bash -c "cd controller && yarn start"

# [コントローラー] コマンドを実行 (汎用)
ctl-exec *args:
    @{{RUN_SCRIPT}} bash -c "cd controller && yarn {{args}}"

# [コントローラー] testsディレクトリ内のスクリプトを実行
ctl-test *args:
    @{{RUN_SCRIPT}} bash -c "cd controller && yarn ts-node src/tests/{{args}}"

# [コントローラー] 指定されたテストケースを実行 (例: just ctl-test --case 1)
ctl-test-case *args:
    @{{RUN_SCRIPT}} bash -c "cd controller && yarn test {{args}}"

# --- Runtime Tasks ---
# ランタイム用コンテナに入る
runtime-shell:
    @{{RUN_SCRIPT}} bash

# コンテナ内でコマンドを実行するためのラッパー
run *args:
    @{{RUN_SCRIPT}} {{args}}

# [コントローラー]コマンドを実行するためのラッパー
run-ctl *args:
    @{{RUN_SCRIPT}} bash -c "cd controller && {{args}}"