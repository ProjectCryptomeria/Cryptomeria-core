#!/bin/bash
# scripts/make/run.sh

set -euo pipefail

# --- Configuration ---
DEV_IMAGE="raidchain/dev-tools:latest"
PROJECT_NAME=$(basename "$(pwd)")
GO_MOD_VOLUME="${PROJECT_NAME}-go-mod"

# ★★★ 所有権を修正するステップを追加 ★★★
if ! docker volume inspect "${GO_MOD_VOLUME}" >/dev/null 2>&1; then
    echo "--> Volume '${GO_MOD_VOLUME}' not found. Creating..."
    docker volume create "${GO_MOD_VOLUME}" >/dev/null
fi

echo "==> 🐳 Executing in container: $@"

docker run --rm -it \
    -u "$(id -u):$(id -g)" \
    --group-add "$(getent group docker | cut -d: -f3)" \
    -v "$(pwd):/workspace" \
    -v "/var/run/docker.sock:/var/run/docker.sock" \
    -v "${HOME}/.kube:/home/user/.kube" \
    -v "${GO_MOD_VOLUME}:/home/tendermint/gomod" \
    -e GOMODCACHE=/home/tendermint/gomod \
    -e IN_CONTAINER=true \
    -e KUBECONFIG=/home/user/.kube/config \
    -e DO_NOT_TRACK=1 \
    --workdir /workspace \
    "${DEV_IMAGE}" \
    "$@"