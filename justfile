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
KIND_CLUSTER_NAME := "raidchain-cluster"

# justコマンドのデフォルトの挙動を設定。コマンド一覧を表示する。
default:
    @just --list

# --- Setup Tasks ---

# 開発用の実行環境(dev-tools)イメージをビルド
init-runtime:
    @docker build -t {{DEV_IMAGE}} -f develop.Dockerfile .
# --- Workflow ---

# [一括実行] クリーンアップ、再生成、ビルド、デプロイを全て実行
all-in-one: clean scaffold-chain build deploy
    @echo "✅ All-in-one process complete!"
# --- Build Tasks ---

# [推奨] 全てのコンポーネントをビルドし、kindクラスタにロード
build: build-datachain build-metachain build-relayer kind-load
    @echo "✅ All images built and loaded into kind cluster."

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

# --- Kind Tasks ---

kind-cluster:
    @echo "==>  Kubeconfig path will be set automatically by kind."
    @{{RUN_SCRIPT}} kind create cluster --name {{KIND_CLUSTER_NAME}}

kind-delete:
    @{{RUN_SCRIPT}} kind delete cluster --name {{KIND_CLUSTER_NAME}}

kind-load: kind-load-datachain kind-load-metachain kind-load-relayer

kind-load-datachain:
    @{{RUN_SCRIPT}} kind load docker-image --name {{KIND_CLUSTER_NAME}} {{IMAGE_DATACHAIN}}
kind-load-metachain:
    @{{RUN_SCRIPT}} kind load docker-image --name {{KIND_CLUSTER_NAME}} {{IMAGE_METACHAIN}}
kind-load-relayer:
    @{{RUN_SCRIPT}} kind load docker-image --name {{KIND_CLUSTER_NAME}} {{IMAGE_RELAYER}}

# --- Kubernetes Tasks ---

# Helmを使い、Kubernetesクラスタにデプロイ
deploy:
    @{{RUN_SCRIPT}} helm dependency update k8s/helm/raidchain
    @{{RUN_SCRIPT}} helm install {{HELM_RELEASE_NAME}} k8s/helm/raidchain --namespace {{NAMESPACE}} --create-namespace --debug

# デプロイされたアプリケーションをクラスタからアンインストール (エラーを無視)
undeploy:
    @-{{RUN_SCRIPT}} helm uninstall {{HELM_RELEASE_NAME}} --namespace {{NAMESPACE}}


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

# [デフォルト] datachain-0 Podのシェルに入る
exec: exec-datachain

# datachain-0 Podのシェルに入る
exec-datachain:
    @{{RUN_SCRIPT}} kubectl exec -it -n {{NAMESPACE}} {{HELM_RELEASE_NAME}}-datachain-0 -- /bin/sh

# metachain-0 Podのシェルに入る
exec-metachain:
    @{{RUN_SCRIPT}} kubectl exec -it -n {{NAMESPACE}} {{HELM_RELEASE_NAME}}-metachain-0 -- /bin/sh


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
clean: undeploy
    @echo "--> 🗑️ Deleting generated chain directories from host..."
    @rm -rf chain/datachain chain/metachain

# K8sリソース(Namespaceごと)を削除
clean-k8s: undeploy
    @{{RUN_SCRIPT}} kubectl delete namespace {{NAMESPACE}} --ignore-not-found