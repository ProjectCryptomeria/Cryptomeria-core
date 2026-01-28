#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# 🛡️ CSU (Cryptomeria Secure Upload) 統合整合性テスト
# ==============================================================================

# ------------------------------------------------------------------------------
# 1. 基本設定
# ------------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
source "${ROOT_DIR}/ops/scripts/lib/common.sh"

# 環境変数
BINARY="${BINARY:-${ROOT_DIR}/apps/gwc/dist/gwcd}"
NODE_URL="${NODE_URL:-tcp://localhost:30007}"
API_URL="${API_URL:-http://localhost:30003}"
CHAIN_ID="${CHAIN_ID:-gwc}"
OWNER_KEY="${OWNER_KEY:-alice}"
KEYRING="--keyring-backend test"

# プロジェクト・ワークスペース
PROJECT_NAME="${PROJECT_NAME:-csu-test-$(date +%s)}"
PROJECT_VERSION="${PROJECT_VERSION:-1.0.0}"
FRAGMENT_SIZE="${FRAGMENT_SIZE:-1024}"
WORKDIR="${WORKDIR:-/tmp/csu-tus-test}"
TEST_DIR="${WORKDIR}/site"
ZIP_FILE="${WORKDIR}/site.zip"
ROOT_PROOF_FILE="${WORKDIR}/root_proof.txt"

# 動的変数
SESSION_ID=""
UPLOAD_TOKEN=""
OWNER_ADDR=""
EXECUTOR_ADDR=""

mkdir -p "${TEST_DIR}"

# ------------------------------------------------------------------------------
# 2. 強化されたユーティリティ
# ------------------------------------------------------------------------------
log_step() { echo -e "\n\033[1;35m=== $1 ===\033[0m"; }
log_info() { echo -e "\033[1;32m[INFO]\033[0m $1"; }
log_err()  { echo -e "\033[1;31m[ERROR]\033[0m $1" >&2; }
fail()     { log_err "$1"; exit 1; }

safe_jq() {
  local input="$1"
  local query="$2"
  echo "${input}" | sed -n '/{/,$p' | jq -r "${query}" 2>/dev/null || echo ""
}

execute_tx() {
  local cmd="$1"
  local tx_res
  tx_res=$(eval "${cmd} -o json --log_level error" || true)
  
  local txhash
  txhash=$(safe_jq "${tx_res}" '.txhash // empty')
  
  if [[ -z "${txhash}" ]]; then
    fail "Tx送信失敗。レスポンス: ${tx_res}"
  fi
  
  log_info "Tx Hash: ${txhash} (コミット待機中...)"
  sleep 6
  "${BINARY}" q tx "${txhash}" --node "${NODE_URL}" -o json
}

# ------------------------------------------------------------------------------
# 3. 実行フェーズ
# ------------------------------------------------------------------------------

# NOTE: phase_infra は削除されました。
# システム起動時の connect-chain.sh により、正しいChainID(fdsc-0)ですでに登録が行われているため、
# ここで重複登録や誤ったID(fdsc)での登録を行うとルーティング不整合の原因となります。

phase_content() {
  log_step "Step 1: コンテンツ準備"
  echo "<h1>CSU Integrity Test</h1><p>Time: $(date)</p>" > "${TEST_DIR}/index.html"
  (cd "${TEST_DIR}" && zip -r "${ZIP_FILE}" . >/dev/null)
  log_info "ZIP作成完了: ${ZIP_FILE}"
}

phase_session() {
  log_step "Step 2: セッション開始 & 権限付与"
  
  OWNER_ADDR=$("${BINARY}" keys show "${OWNER_KEY}" -a ${KEYRING} 2>/dev/null)
  [[ -z "${OWNER_ADDR}" ]] && fail "Key '${OWNER_KEY}' が見つかりません。"

  local tx_res
  tx_res=$(execute_tx "${BINARY} tx gateway init-session ${FRAGMENT_SIZE} 0 --from ${OWNER_KEY} ${KEYRING} --chain-id ${CHAIN_ID} --node ${NODE_URL} -y")

  SESSION_ID=$(safe_jq "${tx_res}" '.events[] | select(.type=="csu_init_session") | .attributes[] | select(.key=="session_id") | .value')
  EXECUTOR_ADDR=$(safe_jq "${tx_res}" '.events[] | select(.type=="csu_init_session") | .attributes[] | select(.key=="executor") | .value')
  
  UPLOAD_TOKEN=$(echo -n "upload_token:${SESSION_ID}" | sha256sum | awk '{print $1}')

  log_info "Session ID: ${SESSION_ID}"
  log_info "Executor  : ${EXECUTOR_ADDR}"

  log_info "権限(Authz/Feegrant)を委譲中..."
  local common="--from ${OWNER_KEY} ${KEYRING} --chain-id ${CHAIN_ID} --node ${NODE_URL} -y"
  
  # Feegrantの付与
  execute_tx "${BINARY} tx feegrant grant ${OWNER_ADDR} ${EXECUTOR_ADDR} ${common}" >/dev/null

  # Authzの付与 (配布、完了、および異常終了時のためのAbort権限も追加)
  execute_tx "${BINARY} tx authz grant ${EXECUTOR_ADDR} generic --msg-type /gwc.gateway.v1.MsgDistributeBatch ${common}" >/dev/null
  execute_tx "${BINARY} tx authz grant ${EXECUTOR_ADDR} generic --msg-type /gwc.gateway.v1.MsgFinalizeAndCloseSession ${common}" >/dev/null
  execute_tx "${BINARY} tx authz grant ${EXECUTOR_ADDR} generic --msg-type /gwc.gateway.v1.MsgAbortAndCloseSession ${common}" >/dev/null
}

phase_merkle() {
  log_step "Step 3: Merkle Root コミット"
  export TEST_DIR FRAGMENT_SIZE ROOT_PROOF_FILE
  python3 -c '
import hashlib, os
def sha256(b): return hashlib.sha256(b).digest()
def hash_frag(p, i, b): return sha256(f"FRAG:{p}:{i}:{sha256(b).hex()}".encode())
def hash_file(p, s, r): return sha256(f"FILE:{p}:{s}:{r.hex()}".encode())
def parent(l, r): return sha256((l.hex() + r.hex()).encode())
def merkle(leaves):
    level = list(leaves)
    while len(level) > 1:
        if len(level) % 2: level.append(level[-1])
        level = [parent(level[i], level[i+1]) for i in range(0, level, 2)]
    return level[0] if level else b""
files = []
for dp, _, fns in os.walk(os.environ["TEST_DIR"]):
    for fn in fns:
        full = os.path.join(dp, fn)
        rel = os.path.relpath(full, os.environ["TEST_DIR"]).replace("\\", "/").lstrip("./")
        with open(full, "rb") as f: data = f.read()
        fsize = len(data)
        frag_size = int(os.environ["FRAGMENT_SIZE"])
        frags = [data[i:i+frag_size] for i in range(0, fsize, frag_size)] or [b""]
        froot = merkle([hash_frag(rel, i, b) for i, b in enumerate(frags)])
        files.append((rel, hash_file(rel, fsize, froot)))
files.sort(key=lambda x: x[0])
root = merkle([f[1] for f in files])
with open(os.environ["ROOT_PROOF_FILE"], "w") as f: f.write(root.hex())
'
  local root_hex=$(cat "${ROOT_PROOF_FILE}")
  execute_tx "${BINARY} tx gateway commit-root-proof ${SESSION_ID} ${root_hex} --from ${OWNER_KEY} ${KEYRING} --chain-id ${CHAIN_ID} --node ${NODE_URL} -y" >/dev/null
}

phase_upload() {
  log_step "Step 4: TUSアップロード"
  local base_url="${API_URL%/}/upload/tus-stream/"
  
  # メタデータをBase64エンコードして構築 (TUSプロトコル仕様)
  # 形式: key value,key value (valueはBase64)
  local sess_b64=$(echo -n "${SESSION_ID}" | base64 | tr -d '\n')
  local proj_b64=$(echo -n "${PROJECT_NAME}" | base64 | tr -d '\n')
  local ver_b64=$(echo -n "${PROJECT_VERSION}" | base64 | tr -d '\n')
  
  local metadata="session_id ${sess_b64},project_name ${proj_b64},version ${ver_b64}"
  
  log_info "POST: ${base_url}"
  log_info "Metadata: Project=${PROJECT_NAME}, Version=${PROJECT_VERSION}"

  local post_resp=$(curl -i -s -X POST "${base_url}" \
    -H "Tus-Resumable: 1.0.0" \
    -H "Upload-Length: $(stat -c%s "${ZIP_FILE}")" \
    -H "Upload-Metadata: ${metadata}" \
    -H "Authorization: Bearer ${UPLOAD_TOKEN}")

  local location=$(echo "${post_resp}" | grep -i "Location:" | awk '{print $2}' | tr -d '\r')
  [[ -z "${location}" ]] && { echo "${post_resp}" >&2; fail "Locationヘッダーがありません。"; }

  local final_url="${location}"
  if [[ "${final_url}" == /* ]] && [[ "${final_url}" != /upload/tus-stream/* ]]; then
    final_url="/upload/tus-stream${final_url}"
  fi
  [[ "${final_url}" == /* ]] && final_url="${API_URL%/}${final_url}"

  log_info "PATCH: ${final_url}"
  curl -i -s -X PATCH "${final_url}" \
    -H "Tus-Resumable: 1.0.0" \
    -H "Content-Type: application/offset+octet-stream" \
    -H "Upload-Offset: 0" \
    --data-binary "@${ZIP_FILE}" | grep -q "204 No Content" || fail "PATCHアップロード失敗"
}

phase_verify() {
  log_step "Step 5: 最終検証"
  for i in {1..20}; do
    local state=$("${BINARY}" q gateway session "${SESSION_ID}" --node "${NODE_URL}" -o json | jq -r '.session.state')
    log_info "   Current State: ${state}"
    [[ "${state}" == "SESSION_STATE_CLOSED_SUCCESS" ]] && break
    [[ "${state}" == "SESSION_STATE_CLOSED_FAILED" ]] && fail "セッションが失敗しました。"
    sleep 3
  done

  # 正しいプロジェクト名とバージョンでレンダリングパスを構築
  local render_url="${API_URL}/render/${PROJECT_NAME}/${PROJECT_VERSION}/index.html"
  log_info "レンダリング確認: ${render_url}"
  
  local code=$(curl -s -o /dev/null -w "%{http_code}" "${render_url}")
  [[ "${code}" == "200" ]] && log_info "✅ テスト成功！" || fail "レンダリング失敗 (Status: ${code})"
}

main() {
  # phase_infra は実行しない (システムによる自動登録を使用)
  phase_content
  phase_session
  phase_merkle
  phase_upload
  phase_verify
}

main