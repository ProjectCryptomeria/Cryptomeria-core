#!/bin/bash

set -euo pipefail

# --- Configuration ---
DEV_TOOLS_IMAGE="raidchain/dev-tools:latest"
TARGET_IMAGE="$1"
shift

PROJECT_NAME=$(basename "$(pwd)")
WORKSPACE_VOLUME="${PROJECT_NAME}-workspace"

# --- 1. Sync from Host to Volume ---
echo "==> 🔄 Syncing local files to volume: ${WORKSPACE_VOLUME} (using ${DEV_TOOLS_IMAGE})"
docker volume create "${WORKSPACE_VOLUME}" > /dev/null
docker run --rm \
    -v "$(pwd):/host" \
    -v "${WORKSPACE_VOLUME}:/workspace" \
    "${DEV_TOOLS_IMAGE}" \
    rsync -a --delete --exclude='.git/' --exclude='dist/' /host/ /workspace/

# --- 2. Execute Command in Container ---
echo "==> 🚀 Executing in container (${TARGET_IMAGE}) with high-speed volume..."
docker run --rm -it \
    -u "$(id -u):$(id -g)" \
    --group-add "$(getent group docker | cut -d: -f3)" \
    -v "${WORKSPACE_VOLUME}:/workspace" \
    -v "/var/run/docker.sock:/var/run/docker.sock" \
    -v "${HOME}/.kube:/home/user/.kube" \
    -e IN_CONTAINER=true \
    -e KUBECONFIG=/home/user/.kube/config \
    -e IGNITE_TELEMETRY_DISABLED=true \
    --workdir /workspace \
    "${TARGET_IMAGE}" \
    bash -c "git config --global --add safe.directory /workspace && exec \"$@\"" bash "$@"

# --- 3. Sync back from Volume to Host ---
echo "==> 🔄 Syncing back from volume to local files... (using ${DEV_TOOLS_IMAGE})"
docker run --rm \
    -v "$(pwd):/host" \
    -v "${WORKSPACE_VOLUME}:/workspace" \
    "${DEV_TOOLS_IMAGE}" \
    rsync -a --delete --exclude='.git/' --exclude='dist/' /workspace/ /host/

echo "==> ✅ Fast execution complete."