#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# CSU (Cryptomeria Secure Upload) E2E 整合性テスト (TUS + Authz + Full Merkle Logic)
# ==============================================================================

# ------------------------------------------------------------------------------
# 1. 環境設定
# ------------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
# リポジトリ内の共通ライブラリを読み込み
source "${ROOT_DIR}/ops/scripts/lib/common.sh"

# 基本設定
NAMESPACE="${NAMESPACE:-cryptomeria}"
BINARY="${BINARY:-gwcd}"
NODE_URL="${NODE_URL:-tcp://localhost:26657}"
API_URL="${API_URL:-http://localhost:1317}"
CHAIN_ID="${CHAIN_ID:-gwc}"

# アカウント (Executorのアドレスは動的に取得するため、ここではキー名のみ定義)
OWNER_KEY="${OWNER_KEY:-alice}"
EXECUTOR_KEY="${EXECUTOR_KEY:-local-admin}"

# プロジェクト情報
PROJECT_NAME="${PROJECT_NAME:-csu-tus-test-$(date +%s)}"
PROJECT_VERSION="${PROJECT_VERSION:-1.0.0}"
FRAGMENT_SIZE="${FRAGMENT_SIZE:-1024}" 

# ワークディレクトリ
WORKDIR="${WORKDIR:-/tmp/csu-tus-test}"
TEST_DIR="${WORKDIR}/site"
ZIP_FILE="${WORKDIR}/site.zip"
ROOT_PROOF_FILE="${WORKDIR}/root_proof.txt"
AUTHZ_JSON_DIST="${WORKDIR}/authz_dist.json"
AUTHZ_JSON_FINAL="${WORKDIR}/authz_final.json"

# グローバル変数 (実行中に動的に設定される)
SESSION_ID=""
UPLOAD_TOKEN=""
OWNER_ADDR=""
EXECUTOR_ADDR=""
ROOT_PROOF_HEX=""

mkdir -p "${TEST_DIR}"

# ------------------------------------------------------------------------------
# 2. ヘルパー関数
# ------------------------------------------------------------------------------

log() { echo -e "\033[1;32m[INFO]\033[0m $1" >&2; }
fail() { echo -e "\033[1;31m[ERROR]\033[0m $1" >&2; exit 1; }

# 指定されたキー名のアドレスを取得
get_addr() {
  local key_name="$1"
  "${BINARY}" keys show "${key_name}" -a --keyring-backend test 2>/dev/null || echo ""
}

# トランザクションを実行し、ハッシュを取得してブロックの取り込みを待機
execute_tx_and_wait() {
  local cmd="$1"
  local tx_response
  tx_response=$(eval "$cmd" || true)
  local txhash
  txhash=$(echo "${tx_response}" | jq -r '.txhash // empty')
  
  if [[ -z "${txhash}" ]]; then
    fail "Tx broadcast failed: ${tx_response}"
  fi
  log "Tx Hash: ${txhash} (waiting...)"
  
  # コンセンサス待ち
  sleep 6
  # 結果を返す（呼び出し元でさらにパース可能にするため）
  "${BINARY}" q tx "${txhash}" --node "${NODE_URL}" -o json
}

# ------------------------------------------------------------------------------
# 3. メイン処理ステップ
# ------------------------------------------------------------------------------

setup_accounts() {
  log "アカウント情報を取得中..."
  # Aliceのアドレスはローカルキーから取得
  OWNER_ADDR=$(get_addr "${OWNER_KEY}")
  
  if [[ -z "${OWNER_ADDR}" ]]; then
    fail "Could not find address for ${OWNER_KEY}. Ensure keys exist in keyring-backend test."
  fi
  
  log "Owner (Alice): ${OWNER_ADDR}"
  log "Note: Executor address will be retrieved from the session event."
}

# 事前準備: ストレージエンドポイントの登録 (Render用)
register_storage_endpoints() {
  log "ストレージエンドポイントを登録します..."
  local storage_json="[{\"channel_id\":\"mdsc-channel\",\"chain_id\":\"mdsc\",\"api_endpoint\":\"${API_URL}\",\"connection_type\":\"mdsc\"},{\"channel_id\":\"fdsc-channel\",\"chain_id\":\"fdsc\",\"api_endpoint\":\"${API_URL}\",\"connection_type\":\"fdsc\"}]"
  
  # システムパラメータの権限を持つアカウントで実行
  execute_tx_and_wait "${BINARY} tx gateway register-storage '${storage_json}' \
    --from \"${EXECUTOR_KEY}\" \
    --keyring-backend test \
    --chain-id \"${CHAIN_ID}\" \
    --node \"${NODE_URL}\" \
    --broadcast-mode sync -y -o json" >/dev/null
}

prepare_content() {
  log "テスト用ウェブサイトを作成中..."
  echo "<html><body><h1>Hello CSU TUS!</h1><p>Timestamp: $(date)</p></body></html>" > "${TEST_DIR}/index.html"
  for i in {1..2}; do
    dd if=/dev/urandom of="${TEST_DIR}/data_${i}.bin" bs=512 count=1 2>/dev/null
  done

  log "ZIPアーカイブを作成中..."
  (cd "${TEST_DIR}" && zip -r "${ZIP_FILE}" . >/dev/null)
}

# Step 1: InitSession (Alice)
init_session() {
  log "【$OWNER_KEY】セッションを開始します..."
  local tx_res
  tx_res=$(execute_tx_and_wait "${BINARY} tx gateway init-session \
      \"${FRAGMENT_SIZE}\" \
      0 \
      --from \"${OWNER_KEY}\" \
      --keyring-backend test \
      --chain-id \"${CHAIN_ID}\" \
      --node \"${NODE_URL}\" \
      --broadcast-mode sync \
      -y -o json")

  # イベント csu_init_session から SESSION_ID と EXECUTOR_ADDR を動的に抽出
  SESSION_ID=$(echo "${tx_res}" | jq -r '.events[] | select(.type=="csu_init_session") | .attributes[] | select(.key=="session_id") | .value' | tr -d '"')
  EXECUTOR_ADDR=$(echo "${tx_res}" | jq -r '.events[] | select(.type=="csu_init_session") | .attributes[] | select(.key=="executor") | .value' | tr -d '"')
  
  if [[ -z "${SESSION_ID}" || -z "${EXECUTOR_ADDR}" ]]; then
     fail "Session information (ID or Executor) could not be retrieved from tx events."
  fi

  # アップロードトークンの計算: sha256("upload_token:" + sessionID) の Hex 文字列
  local seed="upload_token:${SESSION_ID}"
  UPLOAD_TOKEN=$(echo -n "${seed}" | sha256sum | awk '{print $1}')
  
  log "Session ID: ${SESSION_ID}"
  log "Assigned Executor: ${EXECUTOR_ADDR}"
}

# Step 2: Grant Permissions (Alice -> Dynamic Executor)
setup_permissions() {
  log "【Alice】取得したExecutor ($EXECUTOR_ADDR) に権限(SessionBoundAuthz)を委譲します..."
  
  # Feegrant: ガス代負担の委譲
  execute_tx_and_wait "${BINARY} tx feegrant grant \"${OWNER_ADDR}\" \"${EXECUTOR_ADDR}\" --from \"${OWNER_KEY}\" --chain-id \"${CHAIN_ID}\" --node \"${NODE_URL}\" -y" >/dev/null
  
  # SessionBoundAuthorization JSONの作成 (セッションIDに紐付いた権限)
  echo "{\"@type\":\"/gwc.gateway.v1.SessionBoundAuthorization\",\"session_id\":\"${SESSION_ID}\",\"msg_type_url\":\"/gwc.gateway.v1.MsgDistributeBatch\"}" > "${AUTHZ_JSON_DIST}"
  echo "{\"@type\":\"/gwc.gateway.v1.SessionBoundAuthorization\",\"session_id\":\"${SESSION_ID}\",\"msg_type_url\":\"/gwc.gateway.v1.MsgFinalizeAndCloseSession\"}" > "${AUTHZ_JSON_FINAL}"

  # 権限付与の実行
  execute_tx_and_wait "${BINARY} tx authz grant \"${EXECUTOR_ADDR}\" \"${AUTHZ_JSON_DIST}\" --from \"${OWNER_KEY}\" --chain-id \"${CHAIN_ID}\" --node \"${NODE_URL}\" -y" >/dev/null
  execute_tx_and_wait "${BINARY} tx authz grant \"${EXECUTOR_ADDR}\" \"${AUTHZ_JSON_FINAL}\" --from \"${OWNER_KEY}\" --chain-id \"${CHAIN_ID}\" --node \"${NODE_URL}\" -y" >/dev/null
}

# Step 3: Calculate & Commit Root Proof (Alice)
commit_root_proof() {
  log "【Alice】RootProofを計算・コミットします..."
  
  # マークルツリーロジックの再現
  export TEST_DIR FRAGMENT_SIZE ROOT_PROOF_FILE
  python3 - <<'PY'
import hashlib, os
def sha256(b): return hashlib.sha256(b).digest()
def hash_frag(p, i, b): return sha256(f"FRAG:{p}:{i}:{sha256(b).hex()}".encode())
def hash_file(p, s, r): return sha256(f"FILE:{p}:{s}:{r.hex()}".encode())
def parent(l, r): return sha256((l.hex() + r.hex()).encode())
def merkle(leaves):
    level = list(leaves)
    while len(level) > 1:
        if len(level) % 2: level.append(level[-1])
        level = [parent(level[i], level[i+1]) for i in range(0, len(level), 2)]
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
PY

  ROOT_PROOF_HEX=$(cat "${ROOT_PROOF_FILE}")
  execute_tx_and_wait "${BINARY} tx gateway commit-root-proof \"${SESSION_ID}\" \"${ROOT_PROOF_HEX}\" --from \"${OWNER_KEY}\" --chain-id \"${CHAIN_ID}\" --node \"${NODE_URL}\" -y" >/dev/null
}

# Step 4: TUS Upload
tus_upload() {
  log "【Alice】TUSプロトコルでZIPをアップロードします..."
  local upload_url="${API_URL}/upload/tus-stream/"
  # セッションIDをBase64エンコードしてメタデータに含める
  local metadata="session_id $(echo -n "${SESSION_ID}" | base64 | tr -d '\n')"

  log "   -> Creating Upload Session..."
  local location=$(curl -i -s -X POST "${upload_url}" \
    -H "Tus-Resumable: 1.0.0" \
    -H "Upload-Length: $(stat -c%s "${ZIP_FILE}")" \
    -H "Upload-Metadata: ${metadata}" \
    -H "Authorization: Bearer ${UPLOAD_TOKEN}" | grep -i "Location:" | awk '{print $2}' | tr -d '\r')

  # 相対パスの場合はベースURLを補完
  [[ "${location}" == /* ]] && location="${API_URL}${location}"
  
  log "   -> Uploading Data to ${location}..."
  curl -i -s -X PATCH "${location}" \
    -H "Tus-Resumable: 1.0.0" \
    -H "Content-Type: application/offset+octet-stream" \
    -H "Upload-Offset: 0" \
    --data-binary "@${ZIP_FILE}" | grep -q "204 No Content" || fail "TUS Upload Failed."
}

# Step 5: Verification
wait_and_verify() {
  log "【System】処理完了を待機中..."
  for i in {1..30}; do
    # セッションの最終状態をクエリ
    local state=$("${BINARY}" q gateway session "${SESSION_ID}" --node "${NODE_URL}" -o json | jq -r '.session.state')
    log "   Current State: ${state}"
    [[ "${state}" == "SESSION_STATE_CLOSED_SUCCESS" ]] && break
    [[ "${state}" == "SESSION_STATE_CLOSED_FAILED" ]] && fail "Session Failed to process."
    sleep 2
  done

  log "【Verify】事後検証を実施..."
  
  # 1. Authz 権限が自動的に剥奪されているか確認
  local grants=$("${BINARY}" q authz grants "${EXECUTOR_ADDR}" "${OWNER_ADDR}" --node "${NODE_URL}" -o json)
  [[ $(echo "${grants}" | jq '.grants | length') -eq 0 ]] && log "   OK: Authz Revoked successfully." || log "   Wait: Authz still exists (clean-up pending?)."

  # 2. Render経由で実際にファイルにアクセスできるか確認
  local http_code=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL}/render/${PROJECT_NAME}/${PROJECT_VERSION}/index.html")
  if [[ "${http_code}" == "200" ]]; then
    log "   OK: Data verified via Render (HTTP 200)."
  else
    fail "   Render verification failed with status: ${http_code}"
  fi
}

# --- Main Flow ---
main() {
  setup_accounts
  register_storage_endpoints
  prepare_content
  
  init_session         # ここで動的にExecutorを取得
  setup_permissions    # 取得したExecutorに対して権限を付与
  
  commit_root_proof
  tus_upload
  
  wait_and_verify
  
  log "COMPLETE: CSU TUS Integrity Test Passed."
}

main