# justfile
set shell := ["bash", "-c"]

# --- モジュール読み込み ---
mod dev "dev.justfile"
mod test "test.justfile"
mod chain "chain.justfile"

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

template chains=DEFAULT_CHAINS:
	@echo "--> 📄 Rendering Helm template with {{chains}} FDSC node(s)..."
	@helm dependency update "./ops/infra/k8s/helm/{{PROJECT_NAME}}" > /dev/null 2>&1
	@helm template {{PROJECT_NAME}} "./ops/infra/k8s/helm/{{PROJECT_NAME}}" \
		--namespace {{PROJECT_NAME}} \
		--set fdsc.replicas={{chains}}

# [Start] デプロイ済みの環境を初期化し、リレイヤー起動と全接続を行う。
# 修正: init-relayer.sh がチェーンを見逃さないよう、全PodのReadyを待機する手順を追加
start-system:
	@echo "🚀 Starting System (Init -> Start -> Connect All)..."
	@echo "0. Waiting for all pods to be ready..."
	@kubectl -n {{PROJECT_NAME}} wait --for=condition=ready pod --all --timeout=300s
	@echo "1. Initializing Relayer config..."
	@./ops/scripts/control/init-relayer.sh
	@echo "2. Connecting all chains..."
	@./ops/scripts/control/connect-all.sh
	@echo "3. Starting Relayer process..."
	@./ops/scripts/control/start-relayer.sh
	@echo "✅ System started successfully!"

connect chain:
	@./ops/scripts/control/connect-chain.sh {{chain}}

# =============================================================================
# 🔄 Recovery & Cleanup (Restored)
# =============================================================================

# [復活: All-in-One] クリーンアップからデプロイ、起動まで一気に行う
all-in-one chains=DEFAULT_CHAINS:
    @echo "🔥 Running All-in-One Sequence..."
    @just clean
    @just dev::build-all
    @just deploy {{chains}}
    @echo "⏳ Waiting for Pod objects to be created..."
    @sleep 10
    @just start-system
    @echo "✅ All-in-one process complete! System was deployed."

deploy-clean chains=DEFAULT_CHAINS:
	@just clean
	@just deploy {{chains}}
	@echo "✅ Redeployment complete (Namespace preserved)!"

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
# ⏸️ Suspend & Resume (Data Preserved)
# =============================================================================

# [Stop] データを保持したまま、全コンテナを一時停止する (replicas=0)
stop:
	@echo "--> ⏸️ Pausing system (scaling down to 0)..."
	@-kubectl -n {{PROJECT_NAME}} scale statefulset --all --replicas=0
	@-kubectl -n {{PROJECT_NAME}} scale deployment --all --replicas=0
	@echo "✅ System paused. Data is preserved in PVCs."

# [Resume] 一時停止したシステムを再開する (replicas=1)
resume:
	@echo "--> ▶️ Resuming system (scaling up to 1)..."
	@-kubectl -n {{PROJECT_NAME}} scale statefulset --all --replicas=1
	@-kubectl -n {{PROJECT_NAME}} scale deployment --all --replicas=1
	@echo "⏳ Waiting for pods to be ready..."
	@kubectl -n {{PROJECT_NAME}} wait --for=condition=ready pod --all --timeout=120s
	@echo "✅ System resumed! Checking network status..."
	@just network

# =============================================================================
# 🛠️ Operations & Utilities
# =============================================================================

# [Shell] 特定のPod内でシェルを起動
shell target:
	@kubectl exec -it -n {{PROJECT_NAME}} deploy/{{PROJECT_NAME}}-{{target}} -- /bin/bash 2>/dev/null || \
	kubectl exec -it -n {{PROJECT_NAME}} statefulset/{{PROJECT_NAME}}-{{target}} -- /bin/bash

# [Exec] 特定のPod内でコマンドを実行
exec target *command:
	@kubectl exec -it -n {{PROJECT_NAME}} deploy/{{PROJECT_NAME}}-{{target}} -- {{command}} 2>/dev/null || \
	kubectl exec -it -n {{PROJECT_NAME}} statefulset/{{PROJECT_NAME}}-{{target}} -- {{command}}

port-forward:
	@./ops/scripts/control/port-forward.sh