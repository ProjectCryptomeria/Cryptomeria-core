# ==============================================================================
#  変数定義
#  ローカル環境に合わせて変更可能です。
# ==============================================================================
IMAGE_TAG       ?= latest
IMAGE_DATACHAIN ?= raidchain/datachain:$(IMAGE_TAG)
IMAGE_METACHAIN ?= raidchain/metachain:$(IMAGE_TAG)
IMAGE_RELAYER   ?= raidchain/relayer:$(IMAGE_TAG)

HELM_RELEASE_NAME ?= raidchain
NAMESPACE         ?= raidchain

# ==============================================================================
#  Dockerコンテナでの実行用設定
#  ローカルにDocker以外のツールをインストールしないための仕組みです。
# ==============================================================================
IMAGE_DEV_TOOLS   ?= raidchain/dev-tools:latest
DOCKER_IN_DOCKER  ?= false
# コンテナイメージが存在するかどうかをチェック
IMAGE_EXISTS := $(shell docker images -q $(IMAGE_DEV_TOOLS))

# 開発ツール用コンテナのビルド
.PHONY: build-dev-container
build-dev-container:
	@echo ">> Building the development tools container image..."
	@docker build -t $(IMAGE_DEV_TOOLS) -f develop.Dockerfile .

# ターゲットをコンテナ内で実行する汎用コマンド
.PHONY: run-in-container
run-in-container:
	@if ! docker images -q $(IMAGE_DEV_TOOLS) | grep -q .; then \
		make build-dev-container; \
	fi; \
	echo ">> 🚀 Executing workflow in container..."; \
	docker run --rm -it \
		-e DOCKER_IN_DOCKER=true \
		-v $(PWD):/workspace \
		-v /var/run/docker.sock:/var/run/docker.sock \
		-v "${HOME}/.kube:/root/.kube" \
		--workdir /workspace \
		$(IMAGE_DEV_TOOLS) make $(MAKECMDGOALS)

# ==============================================================================
#  ターゲット定義
#  これらのターゲットは全て run-in-container を通して実行されます。
# ==============================================================================
.PHONY: all \
	build build-all build-datachain build-metachain build-relayer \
	deploy undeploy clean \
	test test-dev-container \
	logs logs-all logs-datachain logs-metachain logs-relayer \
	exec exec-datachain exec-metachain \
	scaffold-chain \
	help \
	delete-datachain delete-metachain delete-chain \
	all-in-one

# ホスト環境でmakeコマンドが実行された場合、run-in-containerターゲットに処理を委譲します
# DOCKER_IN_DOCKERがfalse(未定義)の場合にのみ実行されます
ifeq ($(DOCKER_IN_DOCKER), false)
build build-all build-datachain build-metachain build-relayer deploy undeploy clean test test-dev-container logs logs-all logs-datachain logs-metachain logs-relayer exec exec-datachain exec-metachain scaffold-chain help delete-datachain delete-metachain delete-chain all-in-one: run-in-container
else
# コンテナ内でmakeコマンドが実行された場合の実際の処理
# ==============================================================================
#  ビルド関連
# ==============================================================================
build: build-all ## [推奨] 全てのDockerイメージをビルドします (build-allのエイリアス)
build-all: build-datachain build-metachain build-relayer ## 全てのDockerイメージをビルドします
build-datachain: ## datachainのDockerイメージのみをビルドします
	@echo ">> building datachain binary and image..."
	@ignite chain build --path ./chain/datachain -o dist
	@docker build -t $(IMAGE_DATACHAIN) -f build/datachain/Dockerfile .
	@sudo chown -R $(shell id -u):$(shell id -g) dist
build-metachain: ## metachainのDockerイメージのみをビルドします
	@echo ">> building metachain binary and image..."
	@ignite chain build --path ./chain/metachain -o dist
	@docker build -t $(IMAGE_METACHAIN) -f build/metachain/Dockerfile .
	@sudo chown -R $(shell id -u):$(shell id -g) dist
build-relayer: ## relayerのDockerイメージのみをビルドします
	@echo ">> building relayer image..."
	@docker build -t $(IMAGE_RELAYER) -f build/relayer/Dockerfile .
deploy: ## [推奨] Helmを使い、Kubernetesクラスタにraidchainをデプロイします
	@echo ">> Helmチャートの依存関係を更新しています..."
	@helm dependency update k8s/helm/raidchain
	@echo ">> raidchainをデプロイしています... (Namespace: $(NAMESPACE))"
	@helm install $(HELM_RELEASE_NAME) k8s/helm/raidchain \
		--namespace $(NAMESPACE) \
		--create-namespace
undeploy: ## デプロイされたraidchainをクラスタからアンインストールします
	@if helm status $(HELM_RELEASE_NAME) --namespace $(NAMESPACE) >/dev/null 2>&1; then \
		echo ">> raidchainをアンインストールしています... (Namespace: $(NAMESPACE))"; \
		helm uninstall $(HELM_RELEASE_NAME) --namespace $(NAMESPACE); \
	else \
		echo ">> Helmリリース '$(HELM_RELEASE_NAME)' は存在しません。アンインストールをスキップします。"; \
	fi
clean: undeploy ## [推奨] raidchainをアンインストールし、関連リソース(Namespace)も完全に削除します
	@echo ">> Namespace '$(NAMESPACE)' を削除しています..."
	@kubectl delete namespace $(NAMESPACE) --ignore-not-found
	@echo ">> クリーンアップが完了しました"
test: ## [推奨] チェーンの動作確認テスト（トランザクション発行）を実行します
	@./scripts/test/chain-integrity-test.sh
test-dev-container: ## 開発用コンテナ内のツールが正しくインストールされているか確認します
	@echo ">> Verifying tools in the development container..."
	@for cmd in ignite kubectl helm kind go; do \
		if ! command -v $$cmd >/dev/null 2>&1; then \
			echo "💥 Error: $$cmd not found."; \
			exit 1; \
		fi; \
		echo "✅ $$cmd found."; \
	done; \
	echo ">> All required tools are available."
logs: logs-datachain ## datachainのログを表示します (logs-datachainのエイリアス)
logs-all: ## 全てのコンポーネントのログを同時に表示します
	@kubectl logs -f -l app.kubernetes.io/instance=$(HELM_RELEASE_NAME) -n $(NAMESPACE) --max-log-requests=10
logs-datachain: ## datachain Podのログを表示します
	@kubectl logs -f -l app.kubernetes.io/instance=$(HELM_RELEASE_NAME),app.kubernetes.io/name=datachain -n $(NAMESPACE)
logs-metachain: ## metachain Podのログを表示します
	@kubectl logs -f -l app.kubernetes.io/instance=$(HELM_RELEASE_NAME),app.kubernetes.io/name=metachain -n $(NAMESPACE)
logs-relayer: ## relayer Podのログを表示します
	@kubectl logs -f -l app.kubernetes.io/instance=$(HELM_RELEASE_NAME),app.kubernetes.io/name=relayer -n $(NAMESPACE)
exec: exec-datachain ## datachain-0 Podに入ります (exec-datachainのエイリアス)
exec-datachain: ## datachain-0 Podのシェルに入ります
	@echo ">> datachain-0 Podに接続します..."
	@kubectl exec -it -n $(NAMESPACE) $(HELM_RELEASE_NAME)-datachain-0 -- /bin/sh
exec-metachain: ## metachain-0 Podのシェルに入ります
	@echo ">> metachain-0 Podに接続します..."
	@kubectl exec -it -n $(NAMESPACE) $(HELM_RELEASE_NAME)-metachain-0 -- /bin/sh
scaffold-chain: ## (開発用) 新しいチェーンのひな形を生成します
	@echo ">> 🏗️ Scaffolding datachain and metastore modules..."
	@./scripts/scaffold/scaffold-chain.sh datachain datastore
	@echo ">> 🏗️ Scaffolding metachain and metastore modules..."
	@./scripts/scaffold/scaffold-chain.sh metachain metastore
	@echo ">> ✅ Changing file ownership to local user..."
	@chown -R $(shell id -u):$(shell id -g) chain/*
delete-datachain: ## datachainディレクトリを削除します
	@echo ">> Deleting datachain directory..."
	@rm -rf chain/datachain
delete-metachain: ## metachainディレクトリを削除します
	@echo ">> Deleting metachain directory..."
	@rm -rf chain/metachain
delete-chain: delete-datachain delete-metachain ## datachainとmetachainの両方のディレクトリを削除します
all-in-one: clean delete-chain scaffold-chain build-all deploy ## [一括] 既存のデプロイを削除し、チェーンを再生成・ビルド・デプロイします
help: ## このヘルプメッセージを表示します
	@echo "使用可能なターゲット:"
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_0-9-]+:.*?## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
endif