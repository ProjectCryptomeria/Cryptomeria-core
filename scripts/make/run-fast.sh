#!/bin/bash
# scripts/make/run-fast.sh

set -euo pipefail

# --- Configuration ---
DEV_IMAGE="raidchain/dev-tools:latest"

if [ "$#" -lt 1 ]; then
    echo "Error: Missing arguments. Usage: $0 <image> [command...]" >&2
    exit 1
fi
TARGET_IMAGE="$1"
COMMAND_ARGS=("${@:2}")

PROJECT_NAME=$(basename "$(pwd)")
WORKSPACE_VOLUME="${PROJECT_NAME}-workspace"
GO_MOD_VOLUME="${PROJECT_NAME}-go-mod"
GO_BUILD_VOLUME="${PROJECT_NAME}-go-build"

# --- 1. Sync from Host to Volume ---
echo "==> 🔄 Syncing local files to volume: ${WORKSPACE_VOLUME} (using ${DEV_IMAGE})"
docker volume create "${WORKSPACE_VOLUME}" > /dev/null
docker run --rm \
    -v "$(pwd):/host" \
    -v "${WORKSPACE_VOLUME}:/workspace" \
    "${DEV_IMAGE}" \
    rsync -a --delete --exclude='.git/' --exclude='dist/' /host/ /workspace/

# ★★★ 所有権を修正するステップを追加 ★★★
echo "==> 🛠️  Ensuring cache volume permissions..."
docker volume create "${GO_MOD_VOLUME}" > /dev/null
docker volume create "${GO_BUILD_VOLUME}" > /dev/null

# --- 2. Execute Command in Container ---
echo "==> 🚀 Executing in container (${TARGET_IMAGE}) with high-speed volume..."

docker run --rm -it \
    -u "$(id -u):$(id -g)" \
    --group-add "$(getent group docker | cut -d: -f3)" \
    -v "${WORKSPACE_VOLUME}:/workspace" \
    -v "/var/run/docker.sock:/var/run/docker.sock" \
    -v "${HOME}/.kube:/home/user/.kube" \
    -v "${GO_MOD_VOLUME}:/home/tendermint/gomod" \
    -e IN_CONTAINER=true \
    -e KUBECONFIG=/home/user/.kube/config \
    -e DO_NOT_TRACK=1 \
    -e GOMODCACHE=/home/tendermint/gomod \
    --entrypoint /bin/sh \
    --workdir /workspace \
    "${TARGET_IMAGE}" \
    "${COMMAND_ARGS[@]}"

# --- 3. Sync back from Volume to Host ---
echo "==> 🔄 Syncing back from volume to local files... (using ${DEV_IMAGE})"
docker run --rm \
    -v "$(pwd):/host" \
    -v "${WORKSPACE_VOLUME}:/workspace" \
    "${DEV_IMAGE}" \
    rsync -a --delete --exclude='.git/' --exclude='dist/' /workspace/ /host/

echo "==> ✅ Fast execution complete."