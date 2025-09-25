#!/bin/bash
# このスクリプトは、引数として受け取ったコマンドをDockerコンテナ内で実行します。
# プロジェクトのルートディレクトリから実行されることを想定しています。

set -euo pipefail

# 開発用コンテナのイメージ名
DEV_IMAGE="raidchain/dev-tools:latest"

echo "==> 🐳 Executing in container: $@"

docker run --rm -it \
    -u "$(id -u):$(id -g)" \
    --group-add "$(getent group docker | cut -d: -f3)" \
    -v "$(pwd):/workspace" \
    -v "/var/run/docker.sock:/var/run/docker.sock" \
    -v "${HOME}/.kube:/home/user/.kube" \
    -e IN_CONTAINER=true \
    -e KUBECONFIG=/home/user/.kube/config \
    --workdir /workspace \
    "${DEV_IMAGE}" \
    "$@"