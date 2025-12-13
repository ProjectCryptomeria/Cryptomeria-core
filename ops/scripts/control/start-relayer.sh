#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

echo "=== Starting Relayer Process (Background) ==="
ensure_relayer_pod

# 1. 既に起動しているか確認
# pgrepの終了コード1によるkubectlのエラーメッセージを抑制するため、
# リモート側で判定して成功(0)を返すように工夫します。
if pod_exec "$RELAYER_POD" sh -c "pgrep -f 'rly start' > /dev/null 2>&1"; then
    log_warn "Relayer is already running."
    exit 0
fi

# 2. バックグラウンドで起動
log_step "Executing 'rly start' in background..."

# nohupで起動し、stdinを閉じる (< /dev/null) ことでkubectlとの切断をスムーズにします。
# また、rlyコマンドのパス問題を防ぐため、必要であればフルパス指定も検討してください（通常はパスが通っています）。
pod_exec "$RELAYER_POD" sh -c "nohup rly start --log-format json > /home/relayer/.relayer/relayer.log 2>&1 < /dev/null &"

# 3. 起動確認
sleep 3
if pod_exec "$RELAYER_POD" sh -c "pgrep -f 'rly start' > /dev/null 2>&1"; then
    log_success "Relayer started successfully."
    log_info "Logs are being written to /home/relayer/.relayer/relayer.log"
else
    log_error "Failed to start relayer. See logs below:"
    echo "---------------- RELAYER LOG ----------------"
    # エラーログを表示 (存在しない場合のエラーも抑制)
    pod_exec "$RELAYER_POD" cat /home/relayer/.relayer/relayer.log || echo "No log file found."
    echo "---------------------------------------------"
    exit 1
fi