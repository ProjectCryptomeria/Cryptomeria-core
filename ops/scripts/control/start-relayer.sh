#!/bin/bash
set -e
source "$(dirname "$0")/../lib/common.sh"

# LOG_FILEは使用しなくなるため削除（またはコメントアウト）
# LOG_FILE="/home/relayer/.relayer/relayer.log"

# =============================================================================
# 🧩 Functions
# =============================================================================

ensure_stopped() {
    ensure_relayer_pod
    
    # プロセスが起動しているか確認
    if pod_exec "$RELAYER_POD" sh -c "pgrep -f 'rly start' > /dev/null 2>&1"; then
        log_warn "Relayer is currently running. Stopping existing process..."
        
        # [修正] -f (full command) ではなく -x (exact name) を使い、
        # コマンド実行中のシェル自身を巻き込まないようにする
        pod_exec "$RELAYER_POD" sh -c "pkill -x rly" || true
        
        # 完全に停止するまで待機
        for i in {1..10}; do
            if ! pod_exec "$RELAYER_POD" sh -c "pgrep -f 'rly start' > /dev/null 2>&1"; then
                echo "   🛑 Process stopped."
                return 0
            fi
            echo -n "."
            sleep 1
        done
        
        # それでも止まらない場合は強制Kill (SIGKILL)
        log_warn "Force killing..."
        pod_exec "$RELAYER_POD" sh -c "pkill -KILL -x rly" || true
        sleep 1
    fi
}

start_process() {
    log_step "Executing 'rly start' in background..."
    
    # 以前のログファイル作成処理は削除（stdoutに出すため不要）
    # pod_exec "$RELAYER_POD" touch "$LOG_FILE"

    # nohupで起動 (--log-format json でクラッシュ回避)
    # [修正] 出力を /proc/1/fd/1 (PID 1の標準出力) にリダイレクトする
    # これにより、バックグラウンドプロセスの出力が kubectl logs に現れるようになります
    pod_exec "$RELAYER_POD" sh -c "nohup rly start --log-format json > /proc/1/fd/1 2>&1 < /dev/null &"
}

verify_start() {
    sleep 3
    if pod_exec "$RELAYER_POD" sh -c "pgrep -f 'rly start' > /dev/null 2>&1"; then
        log_success "Relayer started successfully."
        # [修正] ログファイルではなく kubectl logs を案内
        log_info "Logs are now streaming to Pod stdout. Check with: kubectl logs $RELAYER_POD"
    else
        log_error "Failed to start relayer."
        # [修正] エラー時も kubectl logs を案内
        log_info "Check logs manually: kubectl logs $RELAYER_POD"
        # pod_exec "$RELAYER_POD" tail -n 10 "$LOG_FILE"
        exit 1
    fi
}

# =============================================================================
# 🚀 Main Execution
# =============================================================================
echo "=== Starting Relayer Process (Background) ==="

ensure_stopped
start_process
verify_start