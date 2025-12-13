# justfile
set shell := ["bash", "-c"]

# --- モジュール読み込み ---
mod dev "dev.justfile"
mod test "test.justfile"

# --- 変数定義 ---
PROJECT_NAME := "cryptomeria"
DEFAULT_CHAINS := "2"

# デフォルト: コマンド一覧表示
default:
	@just --list

# =============================================================================
# 🚀 Main Lifecycle (Deploy & Start)
# =============================================================================

# [Deploy] インフラ(K8sリソース)のみを作成する。
deploy chains=DEFAULT_CHAINS:
	#!/usr/bin/env sh
	set -e
	echo "--> 🚀 Deploying Infrastructure with {{chains}} FDSC node(s)..."
	helm dependency update "./ops/infra/k8s/helm/{{PROJECT_NAME}}"
	helm install {{PROJECT_NAME}} "./ops/infra/k8s/helm/{{PROJECT_NAME}}" \
		--namespace {{PROJECT_NAME}} --create-namespace \
		--set fdsc.replicas={{chains}} --timeout 10m
	echo "✅ Infrastructure deployed. Run 'just start-system' next."

# [Start] デプロイ済みの環境を初期化し、リレイヤー起動と全接続を行う。
start-system:
	@echo "🚀 Starting System (Init -> Start -> Connect All)..."
	@echo "1. Initializing Relayer config..."
	@./ops/scripts/control/init-relayer.sh
	@echo "2. Connecting all chains..."
	@./ops/scripts/control/connect-all.sh
	@echo "3. Starting Relayer process..."
	@./ops/scripts/control/start-relayer.sh
	@echo "✅ System started successfully!"

# [Connect New] 新規追加されたチェーンなどを個別に接続する
connect chain:
	@./ops/scripts/control/connect-chain.sh {{chain}}

# =============================================================================
# 🔄 Recovery & Cleanup (Restored)
# =============================================================================

# [復活: All-in-One] クリーンアップからデプロイ、起動まで一気に行う（開発リセット用）
all-in-one chains=DEFAULT_CHAINS:
	@echo "🔥 Running All-in-One Sequence..."
	@just clean-k8s
	@just dev::build-all
	@just deploy {{chains}}
	@just start-system
	@echo "✅ All-in-one process complete! System is running."

# [復活: Deploy Clean] データだけ消して再デプロイ（高速リセット）
deploy-clean chains=DEFAULT_CHAINS:
	@just undeploy
	@just deploy {{chains}}
	@echo "✅ Redeployment complete (Namespace preserved)!"

# [Undeploy] HelmリリースとPVCを削除
undeploy:
	@echo "--> 🛑 Uninstalling Helm release..."
	@-helm uninstall {{PROJECT_NAME}} --namespace {{PROJECT_NAME}} --wait
	@echo "--> 🗑️ Deleting Data (PVCs)..."
	@-kubectl -n {{PROJECT_NAME}} delete pvc -l app.kubernetes.io/name={{PROJECT_NAME}}
	@-kubectl -n {{PROJECT_NAME}} delete jobs --all
	@-kubectl delete secret {{PROJECT_NAME}}-mnemonics -n {{PROJECT_NAME}} --ignore-not-found

# [Clean] Namespaceごと完全に削除する
clean: undeploy
	@echo "--> 🗑️ Deleting namespace {{PROJECT_NAME}}..."
	@kubectl delete namespace {{PROJECT_NAME}} --ignore-not-found

# =============================================================================
# 🛠️ Operations & Utilities
# =============================================================================

# [Status] ネットワーク接続状況を表示
status:
	@./ops/scripts/util/show-network-status.sh

# [Monitor] システムの健康状態を診断
monitor:
	@./ops/scripts/util/monitor-health.sh

# [Faucet] 任意のアドレスにミリオネアから送金
faucet address amount="10000000uatom":
	@./ops/scripts/util/faucet.sh {{address}} {{amount}}

# [Logs] 特定コンポーネントのログを表示
logs target:
	@kubectl logs -f -n {{PROJECT_NAME}} -l app.kubernetes.io/component={{target}} --max-log-requests=10

# [Shell] 特定のPod内でシェルを起動
shell target:
	@kubectl exec -it -n {{PROJECT_NAME}} deploy/{{PROJECT_NAME}}-{{target}} -- /bin/bash 2>/dev/null || kubectl exec -it -n {{PROJECT_NAME}} statefulset/{{PROJECT_NAME}}-{{target}} -- /bin/bash