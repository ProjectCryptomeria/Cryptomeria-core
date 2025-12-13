#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

echo "=== Starting Relayer Process (Background) ==="
ensure_relayer_pod

# 1. 既に起動しているか確認
# 【修正】pgrep は Linuxコマンドなので pod_exec を使用
if pod_exec "$RELAYER_POD" pgrep -f "rly start" > /dev/null; then
    log_warn "Relayer is already running."
    exit 0
fi

# 2. バックグラウンドで起動
# 【修正】sh も Linuxコマンドなので pod_exec を使用
log_step "Executing 'rly start' in background..."
pod_exec "$RELAYER_POD" sh -c "nohup rly start --log-format json > /home/relayer/.relayer/relayer.log 2>&1 &"

# 3. 起動確認
sleep 2
if pod_exec "$RELAYER_POD" pgrep -f "rly start" > /dev/null; then
    log_success "Relayer started successfully."
    log_info "Logs are being written to /home/relayer/.relayer/relayer.log"
else
    log_error "Failed to start relayer. Check logs inside the pod."
    # デバッグ用にログを表示（catもLinuxコマンドなので pod_exec）
    pod_exec "$RELAYER_POD" cat /home/relayer/.relayer/relayer.log || true
    exit 1
fi