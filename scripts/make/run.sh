#!/bin/bash
# scripts/make/run.sh

set -euo pipefail

# --- Configuration ---
DEV_IMAGE="raidchain/dev-tools:latest"
PROJECT_NAME=$(basename "$(pwd)")
GO_MOD_VOLUME="${PROJECT_NAME}-go-mod"
NODE_MODULES_VOLUME="${PROJECT_NAME}-node-modules"

# Dockerfileで定義したユーザー/グループID
CONTAINER_UID=1000
CONTAINER_GID=1000

# --- Volume Initialization ---
# 各ボリュームが存在しない場合は作成する
if ! docker volume inspect "${GO_MOD_VOLUME}" >/dev/null 2>&1; then
    echo "--> Volume '${GO_MOD_VOLUME}' not found. Creating..."
    docker volume create "${GO_MOD_VOLUME}" >/dev/null
fi
if ! docker volume inspect "${NODE_MODULES_VOLUME}" >/dev/null 2>&1; then
    echo "--> Volume '${NODE_MODULES_VOLUME}' not found. Creating..."
    docker volume create "${NODE_MODULES_VOLUME}" >/dev/null
fi

# ボリュームの所有権をコンテナ内のユーザーに合わせる
# これにより、以降のコンテナ実行でPermission Deniedエラーを防ぐ
echo "--> Ensuring volume permissions are correct..."
docker run --rm \
    -v "${NODE_MODULES_VOLUME}:/data" \
    --user root \
    "${DEV_IMAGE}" \
    chown -R "${CONTAINER_UID}:${CONTAINER_GID}" /data

echo "==> 🐳 Executing in container: $@"

docker run --rm -it \
    -e DOCKER_IN_DOCKER=true \
    -v "$(pwd):/workspace" \
    -v "/var/run/docker.sock:/var/run/docker.sock" \
    -v "${HOME}/.kube:/home/ubuntu/.kube" \
    -v "${GO_MOD_VOLUME}:/go/pkg/mod" \
    -e IN_CONTAINER=true \
    -e DO_NOT_TRACK=1 \
    -e EXECUTION_MODE=local \
    --workdir /workspace \
    "${DEV_IMAGE}" \
    "$@"

# -v "${NODE_MODULES_VOLUME}:/workspace/controller/node_modules" \
