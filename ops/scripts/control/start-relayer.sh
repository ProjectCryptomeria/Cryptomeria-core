#!/bin/bash
set -e
source "$(dirname "$0")/../lib/common.sh"

# =============================================================================
# 🧩 Functions
# =============================================================================

check_if_running() {
    if pod_exec "$RELAYER_POD" sh -c "pgrep -f 'rly start' > /dev/null 2>&1"; then
        log_warn "Relayer is already running."
        exit 0
    fi
}

start_process() {
    log_step "Executing 'rly start' in background..."
    # nohup & stdin close pattern
    pod_exec "$RELAYER_POD" sh -c "nohup rly start --log-format json > /home/relayer/.relayer/relayer.log 2>&1 < /dev/null &"
}

verify_start() {
    sleep 3
    if pod_exec "$RELAYER_POD" sh -c "pgrep -f 'rly start' > /dev/null 2>&1"; then
        log_success "Relayer started successfully."
        log_info "Logs: /home/relayer/.relayer/relayer.log"
    else
        log_error "Failed to start relayer."
    fi
}

# =============================================================================
# 🚀 Main Execution
# =============================================================================
echo "=== Starting Relayer Process (Background) ==="
ensure_relayer_pod

check_if_running
start_process
verify_start