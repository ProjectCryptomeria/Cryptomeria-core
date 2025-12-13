#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

echo "=== Starting Relayer Process (Background) ==="
ensure_relayer_pod

# 既に起動しているか確認
if rly_exec pgrep -f "rly start" > /dev/null; then
    log_warn "Relayer is already running."
    exit 0
fi

# バックグラウンド起動
log_step "Executing 'rly start' in background..."
rly_exec sh -c "nohup rly start --log-format json > /home/relayer/.relayer/relayer.log 2>&1 &"

sleep 2
if rly_exec pgrep -f "rly start" > /dev/null; then
    log_success "Relayer started successfully."
else
    log_error "Failed to start relayer. Check logs at /home/relayer/.relayer/relayer.log inside the pod."
fi