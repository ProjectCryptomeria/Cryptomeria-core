
# dev.just
set shell := ["bash", "-c"]

PROJECT_NAME := "cryptomeria"

_default:
	@just -l dev

# =============================================================================
# 🏗️ Build Tasks
# =============================================================================

# [Build All] 全てのDockerイメージをビルド
build-all:
	@echo "🏗️  Building all images..."
	@just dev::build-chain-all
	@just dev::build-image-all

# [Parallel] 各コンポーネントのビルド定義
[parallel]
build-image-all: (build-image 'fdsc') (build-image 'mdsc') (build-image 'gwc') (build-image 'relayer')

# [Build Image] 個別イメージビルド (Relayerの特殊処理を含む最新版)
build-image target:
	#!/usr/bin/env bash
	set -e
	echo "🐳 Building Docker image for {{target}}..."
	
	# Relayer用: Gatewayバイナリのコピー
	if [ "{{target}}" == "relayer" ]; then
		if [ ! -f "apps/gwc/dist/gwcd" ]; then
			 echo "⚠️  Gwcd binary not found. Compiling gwc first..."
			 cd apps/gwc && ignite chain build -o dist/ --skip-proto && cd -
		fi
		cp "apps/gwc/dist/gwcd" "apps/relayer/gwcd"
	else
		# チェーン用: バイナリビルド
		just dev::build-chain {{target}}
	fi

	cd "apps/{{target}}"
	docker build -t "{{PROJECT_NAME}}/{{target}}:latest" .
	
	if [ "{{target}}" == "relayer" ]; then rm gwcd; fi

[parallel]
build-chain-all: (build-chain 'fdsc') (build-chain 'mdsc') (build-chain 'gwc')
	

# [Build Chain] バイナリのみコンパイル（ローカル実行用）
build-chain target:
	#!/usr/bin/env bash
	set -e
	if [[ ! "{{target}}" =~ ^(fdsc|mdsc|gwc)$ ]]; then
		echo "❌ Error: Invalid target '{{target}}'."
		exit 1
	fi
	echo "🏗️  Compiling binary for {{target}}..."
	cd apps/{{target}} && ignite chain build -o dist/ --skip-proto
	echo "✅ Binary compiled: dist/{{target}}d"

# =============================================================================
# 🔧 Code Generation & Scaffold 
# =============================================================================

# [Generate] ProtoファイルからGoコードを生成
[parallel]
generate-all: (generate 'fdsc') (generate 'mdsc') (generate 'gwc')

generate target:
	@echo "🔧 Generating code for {{target}}..."
	@cd apps/{{target}} && ignite generate proto-go

# [Scaffold] 新しいチェーンの雛形作成
scaffold target:
	#!/usr/bin/env bash
	set -e
	case {{target}} in
		fdsc)
		./ops/scripts/scaffold/scaffold-chain.sh {{target}} fdsc
		;;
		mdsc)
		./ops/scripts/scaffold/scaffold-chain.sh {{target}} metastore
		;;
		gwc)
		./ops/scripts/scaffold/scaffold-chain.sh {{target}} gateway
		;;
		*)
		echo "❌ Error: Invalid target '{{target}}'."
		exit 1
		;;
	esac

# =============================================================================
# 🔥 Hot Reload 
# =============================================================================

# [Hot Reload] ローカルでビルドしたバイナリを稼働中のPodに注入して再起動
hot-reload target:
	#!/usr/bin/env bash
	set -e
	echo "🔥 Hot reloading {{target}}..."
	just dev::build-chain {{target}}
	
	BINARY_NAME="{{target}}d"
	LOCAL_BINARY="apps/{{target}}/dist/$BINARY_NAME"
	POD=$(kubectl get pod -n {{PROJECT_NAME}} -l app.kubernetes.io/component={{target}} -o jsonpath="{.items[0].metadata.name}")
	
	if [ -z "$POD" ]; then echo "❌ Pod not found."; exit 1; fi
	
	echo " 	 Injecting binary into $POD..."
	kubectl cp "$LOCAL_BINARY" {{PROJECT_NAME}}/$POD:/tmp/"$BINARY_NAME"_new
	
	kubectl exec -n {{PROJECT_NAME}} $POD -- /bin/bash -c "
		set -e
		mv /tmp/${BINARY_NAME}_new /home/{{target}}/bin/$BINARY_NAME
		chmod +x /home/{{target}}/bin/$BINARY_NAME
		killall $BINARY_NAME || true
		sleep 2
	"
	echo "✅ {{target}} reloaded!"

# =============================================================================
# 🔌 Controller Utils 
# =============================================================================

ctl-install:
	@cd util/Cryptomeria-TScontroller && yarn install

ctl-dev:
	@cd util/Cryptomeria-TScontroller && yarn start

ctl-exec args:
	@cd util/Cryptomeria-TScontroller && yarn {{args}}