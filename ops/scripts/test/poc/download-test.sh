#!/bin/bash
set -euo pipefail

# =============================================================================
# 🛠️ Configuration
# =============================================================================
NAMESPACE="cryptomeria"

TEST_FILENAME="test-image.png"
# アップロードテストで使用したデータと同じ文字列
EXPECTED_DATA="Hello_Cryptomeria_This_is_a_test_data_fragment_for_IBC_transfer_verification."

# Pod内で書き込み可能な一時ディレクトリ
OUTPUT_DIR="/tmp"
OUTPUT_FILE="${OUTPUT_DIR}/${TEST_FILENAME}"

TIMEOUT_SEC=120
POLL_INTERVAL_SEC=2
EXPECTED_OPEN_CHANNELS=2   # FDSC + MDSC 想定

# =============================================================================
# 📝 Logging Functions
# =============================================================================
log()     { echo -e "\033[1;34m[TEST]\033[0m $*"; }
error()   { echo -e "\033[1;31m[ERROR]\033[0m $*"; }
success() { echo -e "\033[1;32m[PASS]\033[0m $*"; }

# =============================================================================
# 🐳 Kubernetes Exec Helpers
# =============================================================================
kexec() {
  local pod="$1"; shift
  kubectl exec -n "$NAMESPACE" "$pod" -- "$@"
}

ktry() { # 失敗しても止めたくないとき用 (set -e 対策)
  local pod="$1"; shift
  kexec "$pod" "$@" 2>/dev/null || true
}

# =============================================================================
# 🔍 Pod Discovery
# =============================================================================
get_pod_by_component() {
  local target="$1"
  local pod=""

  for _ in {1..5}; do
    # 優先: component ラベル
    pod="$(kubectl get pod -n "$NAMESPACE" \
      -l "app.kubernetes.io/component=$target" \
      -o jsonpath="{.items[0].metadata.name}" 2>/dev/null || true)"

    # フォールバック: instance ラベル（既存環境互換）
    if [[ -z "$pod" && "$target" == "gwc" ]]; then
      pod="$(kubectl get pod -n "$NAMESPACE" \
        -l "app.kubernetes.io/instance=gwc" \
        -o jsonpath="{.items[0].metadata.name}" 2>/dev/null || true)"
    fi

    if [[ -n "$pod" ]]; then
      echo "$pod"
      return 0
    fi

    # フォールバック: StatefulSet命名規則の直接推測
    if [[ "$target" == "fdsc-0" ]]; then
      echo "cryptomeria-fdsc-0-0"
      return 0
    fi

    sleep 1
  done

  echo ""
  return 1
}

# =============================================================================
# 🩺 Diagnostics & Wait Logic
# =============================================================================

# GWCの状態確認用ヘルパー
gwc_channels_json() {
  local gwc_pod="$1"
  ktry "$gwc_pod" gwcd q ibc channel channels -o json
}

gwc_channel_ids() {
  local gwc_pod="$1"
  gwc_channels_json "$gwc_pod" | jq -r '.channels // [] | .[].channel_id'
}

gwc_packet_commitments_json() {
  local gwc_pod="$1"
  local channel_id="$2"
  ktry "$gwc_pod" gwcd q ibc channel packet-commitments gateway "$channel_id" -o json
}

# 汎用 Wait関数
wait_for_condition() {
  local label="$1"
  local condition_cmd="$2"

  log "⏳ Waiting for $label..."
  local elapsed=0

  while (( elapsed < TIMEOUT_SEC )); do
    if eval "$condition_cmd"; then
      echo ""
      success "$label OK! (Time: ${elapsed}s)"
      return 0
    fi

    echo -ne "    ... checking (${elapsed}/${TIMEOUT_SEC}s)\r"
    sleep "$POLL_INTERVAL_SEC"
    elapsed=$((elapsed + POLL_INTERVAL_SEC))
  done

  echo ""
  error "Timed out waiting for $label."
  return 1
}

wait_for_open_channels() {
  local gwc_pod="$1"
  local expected="$2"

  log "🔍 Checking IBC Channel Status on GWC..."
  # クオートが複雑になるため、条件判定部分を慎重に構築
  wait_for_condition "at least ${expected} OPEN channels on ${gwc_pod}" \
    "OPEN=\$(gwc_channels_json \"$gwc_pod\" | jq -r '.channels // [] | map(select(.state == \"STATE_OPEN\")) | length' 2>/dev/null || echo 0); [[ \"\$OPEN\" -ge \"$expected\" ]]"
}

wait_for_file_exists_in_pod() {
  local pod="$1"
  local path="$2"
  wait_for_condition "downloaded file exists (${path})" \
    "kexec \"$pod\" test -f \"$path\" >/dev/null 2>&1"
}

diagnose_pending_packets() {
  local gwc_pod="$1"

  echo ""
  log "🩺 Diagnostics: Checking Pending Packets on GWC..."

  local channels
  channels="$(gwc_channel_ids "$gwc_pod" || true)"

  if [[ -z "$channels" ]]; then
    error "No channels found (cannot diagnose commitments)."
    return 0
  fi

  local channel commitments count
  for channel in $channels; do
    commitments="$(gwc_packet_commitments_json "$gwc_pod" "$channel")"
    count="$(echo "$commitments" | jq '.commitments // [] | length' 2>/dev/null || echo 0)"

    if [[ "$count" -gt 0 ]]; then
      error "Pending packets found on ${channel} (Count: ${count}). Relayer might be stuck."
    else
      log "No pending packets on ${channel}."
    fi
  done
}

# ホスト側でのMD5計算 (macOS/Linux互換)
calc_md5_host() {
  echo -n "$1" | md5sum 2>/dev/null | awk '{print $1}' || echo -n "$1" | md5 2>/dev/null | awk '{print $1}'
}

# =============================================================================
# 🚀 Main Execution
# =============================================================================
log "🚀 Starting Enhanced Proxy Download Test (Client -> GWC -> MDSC/FDSC) ..."

# 0) 依存コマンドチェック
command -v kubectl >/dev/null 2>&1 || { error "kubectl not found."; exit 1; }
command -v jq >/dev/null 2>&1 || { error "jq not found on host. Please install jq."; exit 1; }

# 1) Pod 解決
GWC_POD="$(get_pod_by_component gwc)"
MDSC_POD="$(get_pod_by_component mdsc || true)"
FDSC_POD="$(get_pod_by_component fdsc-0 || true)"

if [[ -z "$GWC_POD" ]]; then
  error "Failed to find GWC pod. Is the chain deployed in namespace '$NAMESPACE'?"
  exit 1
fi
log "Target Pods: GWC=$GWC_POD${MDSC_POD:+, MDSC=$MDSC_POD}${FDSC_POD:+, FDSC=$FDSC_POD}"

# 2) IBC チャネル OPEN 待機
wait_for_open_channels "$GWC_POD" "$EXPECTED_OPEN_CHANNELS" || {
  error "Timed out waiting for IBC channels. Is Relayer running?"
  diagnose_pending_packets "$GWC_POD" || true
  exit 1
}

# 3) 出力先準備（Pod内）
log "🧹 Preparing output path on GWC..."
kexec "$GWC_POD" mkdir -p "$OUTPUT_DIR"
ktry  "$GWC_POD" rm -f "$OUTPUT_FILE"

# 4) Download 実行
log "🔌 Triggering Download via GWC CLI..."
log "    Target File: $TEST_FILENAME"
log "    Save Dir   : $OUTPUT_DIR"

# 注意: gwcd q gateway download はクエリなのでガス代はかからない
if ! kexec "$GWC_POD" gwcd q gateway download "$TEST_FILENAME" --save-dir "$OUTPUT_DIR"; then
  error "Download command failed."
  diagnose_pending_packets "$GWC_POD" || true
  exit 1
fi

# 5) ファイル到着待機
wait_for_file_exists_in_pod "$GWC_POD" "$OUTPUT_FILE" || {
  error "Downloaded file not found at $OUTPUT_FILE"
  diagnose_pending_packets "$GWC_POD" || true
  exit 1
}

# 6) 検証（内容照合）
log "✅ Verifying content integrity..."

# NOTE: テストデータがテキストベースのため、catで取得してシェル変数に入れて比較可能
# バイナリデータの場合は md5sum をPod内で実行してハッシュだけ取得するアプローチが推奨される
RESTORED_CONTENT="$(kexec "$GWC_POD" cat "$OUTPUT_FILE" || true)"

ORIGINAL_HASH="$(calc_md5_host "$EXPECTED_DATA")"
RESTORED_HASH="$(calc_md5_host "$RESTORED_CONTENT")"

log "    Original Hash: $ORIGINAL_HASH"
log "    Restored Hash: $RESTORED_HASH"

if [[ "$ORIGINAL_HASH" == "$RESTORED_HASH" ]]; then
  success "🎉 Success! Data retrieved via GWC proxy matches original."

  FILE_SIZE="$(kexec "$GWC_POD" wc -c "$OUTPUT_FILE" | awk '{print $1}')"

  echo "      File Path: $OUTPUT_FILE"
  echo "      File Size: $FILE_SIZE bytes"
  echo "      Content  : $RESTORED_CONTENT"
else
  error "Data mismatch."
  echo "      Expected: $EXPECTED_DATA"
  echo "      Got     : $RESTORED_CONTENT"
  diagnose_pending_packets "$GWC_POD" || true
  exit 1
fi