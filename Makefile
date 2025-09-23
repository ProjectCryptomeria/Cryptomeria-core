# ==============================================================================
#  変数定義
#  ローカル環境に合わせて変更可能です。
#  例: make build IMAGE_TAG=v0.1.0
# ==============================================================================
IMAGE_TAG       ?= latest
IMAGE_DATACHAIN ?= raidchain/datachain:$(IMAGE_TAG)
IMAGE_METACHAIN ?= raidchain/metachain:$(IMAGE_TAG)
IMAGE_RELAYER   ?= raidchain/relayer:$(IMAGE_TAG)

HELM_RELEASE_NAME ?= raidchain
NAMESPACE         ?= raidchain


# ==============================================================================
#  ターゲット定義
# ==============================================================================
.PHONY: all \
	build build-all build-datachain build-metachain build-relayer \
	deploy undeploy clean \
	test \
	logs logs-all logs-datachain logs-metachain logs-relayer \
	exec exec-datachain exec-metachain \
	scaffold-chain \
	help

# デフォルトターゲット (make とだけ打った時に実行される)
all: help

##@----------------------------------------------------------------------------
##@ ビルド関連
##@----------------------------------------------------------------------------

build: build-all ## [推奨] 全てのDockerイメージをビルドします (build-allのエイリアス)
build-all: build-datachain build-metachain build-relayer ## 全てのDockerイメージをビルドします

build-datachain: ## datachainのDockerイメージのみをビルドします
	@echo ">> building datachain image..."
	@docker build -t $(IMAGE_DATACHAIN) -f build/datachain/Dockerfile .

build-metachain: ## metachainのDockerイメージのみをビルドします
	@echo ">> building metachain image..."
	@docker build -t $(IMAGE_METACHAIN) -f build/metachain/Dockerfile .

build-relayer: ## relayerのDockerイメージのみをビルドします
	@echo ">> building relayer image..."
	@docker build -t $(IMAGE_RELAYER) -f build/relayer/Dockerfile .

##@----------------------------------------------------------------------------
##@ デプロイ & クリーンアップ関連
##@----------------------------------------------------------------------------

deploy: ## [推奨] Helmを使い、Kubernetesクラスタにraidchainをデプロイします
	@echo ">> Helmチャートの依存関係を更新しています..."
	@helm dependency update k8s/helm/raidchain
	@echo ">> raidchainをデプロイしています... (Namespace: $(NAMESPACE))"
	@helm install $(HELM_RELEASE_NAME) k8s/helm/raidchain \
		--namespace $(NAMESPACE) \
		--create-namespace

undeploy: ## デプロイされたraidchainをクラスタからアンインストールします
	@echo ">> raidchainをアンインストールしています... (Namespace: $(NAMESPACE))"
	@helm uninstall $(HELM_RELEASE_NAME) --namespace $(NAMESPACE)

clean: undeploy ## [推奨] raidchainをアンインストールし、関連リソース(Namespace)も完全に削除します
	@echo ">> Namespace '$(NAMESPACE)' を削除しています..."
	@kubectl delete namespace $(NAMESPACE) --ignore-not-found
	@echo ">> クリーンアップが完了しました"

##@----------------------------------------------------------------------------
##@ テスト関連
##@----------------------------------------------------------------------------

test: ## [推奨] チェーンの動作確認テスト（トランザクション発行）を実行します
	@./scripts/test/chain-integrity-test.sh

##@----------------------------------------------------------------------------
##@ デバッグ関連 (ログ確認・Podへのアクセス)
##@----------------------------------------------------------------------------

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

##@----------------------------------------------------------------------------
##@ その他
##@----------------------------------------------------------------------------

scaffold-chain: ## (開発用) 新しいチェーンのひな形を生成します
	@./scripts/scaffold/scaffold-chain.sh

help: ## このヘルプメッセージを表示します
	@echo "使用可能なターゲット:"
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_0-9-]+:.*?## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
