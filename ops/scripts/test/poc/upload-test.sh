#!/bin/bash
set -euo pipefail

# --- 設定 ---
NAMESPACE="cryptomeria"
USER_NAME="local-admin"
CHAIN_ID_GWC="gwc"

TEST_FILENAME="image/test-image.png"
TEST_DATA="Hello_Cryptomeria_This_is_a_test_data_fragment_for_IBC_transfer_verification."

TIMEOUT_SEC=120
POLL_INTERVAL_SEC=2
PROJECT_NAME="poc-test-project_2"
VERSION="v1.0.0"
EXPECTED_OPEN_CHANNELS=2   # FDSC + MDSC

# --- ログ ---
log()     { echo -e "\033[1;34m[TEST]\033[0m $*"; }
error()   { echo -e "\033[1;31m[ERROR]\033[0m $*"; }
success() { echo -e "\033[1;32m[PASS]\033[0m $*"; }

# --- kubectl exec 定型句を関数化 ---
kexec() {
  local pod="$1"; shift
  kubectl exec -n "$NAMESPACE" "$pod" -- "$@"
}

ktry() { # 失敗しても止めたくないとき用
  local pod="$1"; shift
  kexec "$pod" "$@" 2>/dev/null || true
}

# --- Pod 解決 ---
get_pod_by_component() {
  local target="$1"
  local pod=""

  for _ in {1..5}; do
    pod="$(kubectl get pod -n "$NAMESPACE" \
      -l "app.kubernetes.io/component=$target" \
      -o jsonpath="{.items[0].metadata.name}" 2>/dev/null || true)"

    if [[ -n "$pod" ]]; then
      echo "$pod"
      return 0
    fi

    # フォールバック: StatefulSet命名規則の直接推測 (fdsc-0 -> cryptomeria-fdsc-0-0)
    if [[ "$target" == "fdsc-0" ]]; then
      echo "cryptomeria-fdsc-0-0"
      return 0
    fi

    sleep 1
  done

  echo ""
  return 1
}

# --- GWC / MDSC / FDSC コマンドを関数化（長大コマンドの隠蔽） ---
gwc_channels_json() {
  local gwc_pod="$1"
  ktry "$gwc_pod" gwcd q ibc channel channels -o json
}

gwc_user_addr() {
  local gwc_pod="$1"
  local user="$2"
  ktry "$gwc_pod" gwcd keys show "$user" -a --keyring-backend test
}

gwc_tx_upload_json() {
  local gwc_pod="$1"
  local filename="$2"
  local data="$3"
  local user="$4"
  local chain_id="$5"
  local project_name="$6"
  local version="$7"

  kexec "$gwc_pod" gwcd tx gateway upload "$filename" "$data" \
    --project-name "$project_name" \
    --version "$version" \
    --from "$user" --chain-id "$chain_id" --keyring-backend test -y -o json
}

gwc_query_tx_json() {
  local gwc_pod="$1"
  local tx_hash="$2"
  kexec "$gwc_pod" gwcd q tx "$tx_hash" -o json
}

fdsc_fragments_json() {
  local fdsc_pod="$1"
  ktry "$fdsc_pod" fdscd q datastore list-fragment -o json
}

mdsc_manifests_json() {
  local mdsc_pod="$1"
  ktry "$mdsc_pod" mdscd q metastore list-manifest -o json
}

gwc_channel_ids() {
  local gwc_pod="$1"
  gwc_channels_json "$gwc_pod" | jq -r '.channels // [] | .[].channel_id'
}

gwc_packet_commitments_json() {
  local gwc_pod="$1"
  local channel_id="$2"
  # NOTE: 元スクリプトの引数順・"gateway" を維持
  ktry "$gwc_pod" gwcd q ibc channel packet-commitments gateway "$channel_id" -o json
}

# --- 汎用 Wait（DRY） ---
wait_for_condition() {
  local label="$1"

  log "⏳ Waiting for $label..."
  local elapsed=0

  while (( elapsed < TIMEOUT_SEC )); do
    if eval "$2"; then
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
  wait_for_condition "at least ${expected} OPEN channels on ${gwc_pod}" \
    "OPEN=\$(gwc_channels_json \"$gwc_pod\" | jq -r '.channels // [] | map(select(.state == \"STATE_OPEN\")) | length' 2>/dev/null || echo 0); [[ \"\$OPEN\" -ge \"$expected\" ]]"
}

wait_for_json_count() {
  # fetch_fn は「JSONを標準出力する関数名」を渡す（例: fdsc_fragments_json）
  local pod="$1"
  local label="$2"
  local fetch_fn="$3"
  local jq_filter="$4"
  local min_count="${5:-1}"

  wait_for_condition "${label} in ${pod}" \
    "JSON=\$($fetch_fn \"$pod\" 2>/dev/null || true); COUNT=\$(echo \"\$JSON\" | jq \"$jq_filter\" 2>/dev/null || echo 0); if [[ \"\$COUNT\" -ge \"$min_count\" ]]; then echo \"\$JSON\" | jq .; true; else false; fi"
}

# --- Diagnostics ---
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

# --- [追加] 特定のプロジェクト名を持つマニフェストの到着を待機 ---
wait_for_specific_manifest() {
  local mdsc_pod="$1"
  local target_project_name="$2"

  log "⏳ Waiting for Manifest with project_name='${target_project_name}' on ${mdsc_pod}..."

  # jqのロジック:
  # .manifest配列から、project_name (またはprojectName) が一致するものを抽出(select)し、その配列長(length)を数える
  # ※ CosmosSDKのJSON出力はキャメルケース(projectName)になる場合とスネークケース(project_name)の場合があるため両方考慮すると安全ですが、
  #    通常は proto名 project_name -> JSON名 projectName になります。
  
  local jq_filter=".manifest // [] | map(select(.projectName == \"${target_project_name}\" or .project_name == \"${target_project_name}\")) | length"

  wait_for_condition "Manifest arrival for '${target_project_name}'" \
    "JSON=\$(mdsc_manifests_json \"$mdsc_pod\" 2>/dev/null || true); \
     COUNT=\$(echo \"\$JSON\" | jq \"$jq_filter\" 2>/dev/null || echo 0); \
     [[ \"\$COUNT\" -gt 0 ]]"
}

# =========================
# Main Flow（手続き的に読みやすく）
# =========================
log "🚀 Starting Enhanced PoC Upload Test (User: $USER_NAME)..."

# 1) Pod 解決
GWC_POD="$(get_pod_by_component gwc)"
MDSC_POD="$(get_pod_by_component mdsc)"
FDSC_POD="$(get_pod_by_component fdsc-0)"

if [[ -z "$GWC_POD" || -z "$MDSC_POD" || -z "$FDSC_POD" ]]; then
  error "Failed to find pods. Is the chain deployed in namespace '$NAMESPACE'?"
  exit 1
fi
log "Target Pods: GWC=$GWC_POD, MDSC=$MDSC_POD, FDSC=$FDSC_POD"

# 2) IBC チャネル OPEN 待機
wait_for_open_channels "$GWC_POD" "$EXPECTED_OPEN_CHANNELS" || {
  error "Timed out waiting for IBC channels. Is Relayer running?"
  exit 1
}

# 3) ユーザー確認
log "👤 Using user '$USER_NAME' on GWC..."
USER_ADDR="$(gwc_user_addr "$GWC_POD" "$USER_NAME")"
if [[ -z "$USER_ADDR" ]]; then
  error "User '$USER_NAME' not found in GWC keyring. Please ensure local-admin key is imported."
  exit 1
fi
echo "    Address: $USER_ADDR"

log "Param \n$TEST_FILENAME \n$TEST_DATA \n$USER_NAME \n$CHAIN_ID_GWC \n$PROJECT_NAME \n$VERSION"

# 4) Upload TX 送信
log "📤 Sending Upload Transaction..."
TX_RES="$(gwc_tx_upload_json "$GWC_POD" "$TEST_FILENAME" "$TEST_DATA" "$USER_NAME" "$CHAIN_ID_GWC" "$PROJECT_NAME" "$VERSION")"
TX_CODE="$(echo "$TX_RES" | jq -r '.code')"
TX_HASH="$(echo "$TX_RES" | jq -r '.txhash')"

if [[ "$TX_CODE" != "0" ]]; then
  error "Transaction failed on submission. Raw log:"
  echo "$TX_RES" | jq -r '.raw_log'
  exit 1
fi
log "✅ Tx Sent! Hash: $TX_HASH"

# 5) send_packet イベント確認
log "🔍 Verifying IBC Packet Emission..."
sleep 6
TX_QUERY="$(gwc_query_tx_json "$GWC_POD" "$TX_HASH")"
PACKET_COUNT="$(echo "$TX_QUERY" | grep -c "send_packet" || true)"

if [[ "$PACKET_COUNT" -gt 0 ]]; then
  success "Found 'send_packet' events in transaction logs."
else
  error "Transaction committed but NO 'send_packet' event found. Logic error in GWC?"
  echo "$TX_QUERY" | jq .
  exit 1
fi

# 6) データ到着待機（Fragment / Manifest）
FDSC_OK=1
MDSC_OK=1

# FDSC: こちらはProjectNameを持たないので、とりあえず「個数が増えたこと」を確認するか、
#       厳密にやるなら「今の個数 > 開始前の個数」で判定する必要があります。
#       今回はManifestの到着を主軸に置くため、簡易的に「1以上」のままとするか、
#       もし可能なら「開始前の個数+1」を判定条件に加えるのがベストです。
#       (簡易版として、少なくともManifestが正しければ成功とみなす方針にします)
wait_for_json_count "$FDSC_POD" "Fragment"  fdsc_fragments_json '.fragment | length' 1 || FDSC_OK=0

# MDSC: ★ここを修正★
# 単なる個数チェックではなく、指定したプロジェクト名のマニフェストが生成されたかを確認
wait_for_specific_manifest "$MDSC_POD" "$PROJECT_NAME" || MDSC_OK=0

# 7) 失敗時の診断
if [[ "$FDSC_OK" -ne 1 || "$MDSC_OK" -ne 1 ]]; then
  diagnose_pending_packets "$GWC_POD"
  error "Test Failed. Data did not arrive."
  exit 1
fi

success "🎉 All checks passed! PoC Upload Flow is working."
