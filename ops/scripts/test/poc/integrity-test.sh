#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# CSU (Cryptomeria Secure Upload) エンドツーエンド整合性テスト
# ==============================================================================
#
# 【テスト内容】
# 1. セッションフローの確認: InitSession -> CommitRootProof -> DistributeBatch -> FinalizeAndCloseSession
# 2. フラグメント検証: verify_fragment が機能すること (証明が有効であること)
# 3. 重複排除: 重複したフラグメント送信が拒否されること
# 4. MDSC連携: MDSCがマニフェストを受信し、RootProofが一致すること
# 5. セッション完了: MDSCからのACKにより、GWCセッションが CLOSED_SUCCESS になること
# 6. FDSC保存 (ベストエフォート): FDSCがフラグメントを保存していること
#
# ==============================================================================

# ------------------------------------------------------------------------------
# 1. 環境設定と初期化
# ------------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

# 共通ライブラリの読み込み
source "${ROOT_DIR}/ops/scripts/lib/common.sh"

# 基本設定 (環境変数でオーバーライド可能)
NAMESPACE="${NAMESPACE:-cryptomeria}"
BINARY="${BINARY:-/workspace/apps/gwc/dist/gwcd}"
NODE_URL="${NODE_URL:-tcp://localhost:26657}"
CHAIN_ID="${CHAIN_ID:-gwc}"  # ローカルノードと一致させる必要があります

# テスト用アカウント
OWNER_KEY="${OWNER_KEY:-alice}"
EXECUTOR_KEY="${EXECUTOR_KEY:-local-admin}"

# プロジェクト設定
PROJECT_NAME="${PROJECT_NAME:-csu-test-$(date +%s)}"
PROJECT_VERSION="${PROJECT_VERSION:-1.0.0}"
FRAGMENT_SIZE="${FRAGMENT_SIZE:-16}" # verify_fragment テスト用に小さめのサイズを指定

# ワークディレクトリとファイルパス設定
WORKDIR="${WORKDIR:-/tmp/csu-integrity-test}"
TEST_DIR="${WORKDIR}/site"
ITEMS_JSON="${WORKDIR}/items.json"
MANIFEST_JSON="${WORKDIR}/manifest.json"
ROOT_PROOF_FILE="${WORKDIR}/root_proof.txt"
SESSION_JSON="${WORKDIR}/session.json"

# グローバル変数 (処理中に設定される)
SESSION_ID=""
ROOT_PROOF_HEX=""
FDSC_CHANNELS=""
MDSC_CHANNEL=""

mkdir -p "${TEST_DIR}"

# ------------------------------------------------------------------------------
# 2. ヘルパー関数定義
# ------------------------------------------------------------------------------

# ログ出力用ヘルパー
log() {
  echo -e "\033[1;32m[INFO]\033[0m $1"
}

fail() {
  echo -e "\033[1;31m[ERROR]\033[0m $1" >&2
  exit 1
}

# トランザクションを実行し、コミットされるまで待機する関数
# (common.sh の exec_tx_and_wait は `q tx` に --node を含まない場合があるため、ここで再定義)
execute_tx_and_wait() {
  local cmd="$1"
  local max_retries="${2:-30}"

  local tx_response
  # コマンド実行 (失敗してもスクリプトを止めずにキャプチャする)
  tx_response=$(eval "$cmd" 2>/dev/null || true)
  
  local txhash
  txhash=$(echo "${tx_response}" | jq -r '.txhash // empty')
  
  if [[ -z "${txhash}" ]]; then
    echo "Txレスポンス内容:" >&2
    echo "${tx_response}" >&2
    fail "トランザクションのブロードキャストに失敗しました (txhash が取得できません)"
  fi

  log "Tx ブロードキャスト完了: ${txhash} (コミット待ち...)"
  
  for _ in $(seq 1 "${max_retries}"); do
    local tx_result
    # 指定したノードに対してTxの結果を問い合わせる
    tx_result=$(${BINARY} q tx "${txhash}" --node "${NODE_URL}" -o json 2>/dev/null || true)
    
    if [[ -n "${tx_result}" && "${tx_result}" != "null" ]]; then
      local code
      code=$(echo "${tx_result}" | jq -r '.code // empty')
      
      if [[ "${code}" == "0" ]]; then
        echo "${tx_result}"
        return 0
      fi
      
      echo "Tx 失敗詳細:" >&2
      echo "${tx_result}" >&2
      fail "トランザクションが失敗しました (code=${code})"
    fi
    sleep 2
  done
  
  fail "トランザクション ${txhash} の待機がタイムアウトしました"
}

# ------------------------------------------------------------------------------
# 3. メイン処理ステップ関数
# ------------------------------------------------------------------------------

# Step 1: テスト用ファイルの作成
create_test_files() {
  log "${TEST_DIR} 配下に決定論的なテスト用ファイルを作成します"

  # 以下の条件を満たすように3つのファイルを作成:
  # - ファイル数が奇数 (ルートレベルでのMerkleツリーの奇数重複チェック)
  # - フラグメント数が奇数になるファイルを含める (ファイルレベルでのMerkleツリーチェック)
  
  cat > "${TEST_DIR}/index.html" <<'EOF'
<html><body>CSU TEST: index.html -- 0123456789abcdefX</body></html>
EOF

  cat > "${TEST_DIR}/style.css" <<'EOF'
/* CSU TEST: style.css */
body{font-family:sans-serif;}
EOF

  cat > "${TEST_DIR}/script.js" <<'EOF'
// CSU TEST: script.js
console.log("csu-integrity-test", "0123456789abcdef");
EOF
}

# Step 2: GWCからストレージチャンネル情報を取得
discover_storage_channels() {
  log "GWCからストレージチャンネル (fdsc/mdsc) を検索しています"

  local storage_json
  storage_json="$(${BINARY} q gateway storage-endpoints --node "${NODE_URL}" -o json 2>/dev/null || true)"

  if [[ -z "${storage_json}" || "${storage_json}" == "null" ]]; then
    log "警告: ローカルノードから storage-endpoints を取得できませんでした。チェーンのデフォルト値に依存して続行します。"
    storage_json='{"storage_infos":[]}'
  fi

  # FDSCチャンネルIDのリストを取得
  FDSC_CHANNELS=$(echo "${storage_json}" | jq -r '.storage_infos[]? | select(.connection_type=="fdsc") | .channel_id' | sort -u | tr '\n' ' ' | sed 's/ *$//')
  # MDSCチャンネルIDを取得
  MDSC_CHANNEL=$(echo "${storage_json}" | jq -r '.storage_infos[]? | select(.connection_type=="mdsc") | .channel_id' | head -n1)

  if [[ -z "${FDSC_CHANNELS}" ]]; then
    log "警告: storage_endpoints に FDSC チャンネルが見つかりません。DistributeBatch が失敗する可能性があります。"
  fi
  if [[ -z "${MDSC_CHANNEL}" || "${MDSC_CHANNEL}" == "null" ]]; then
    log "警告: storage_endpoints に MDSC チャンネルが見つかりません。Finalize が失敗する可能性があります。"
  fi
}

# Step 3: セッションの初期化 (InitSession)
init_session() {
  log "セッション初期化を実行します (owner=${OWNER_KEY}, executor=${EXECUTOR_KEY}, fragment_size=${FRAGMENT_SIZE})"

  local init_res
  init_res=$(execute_tx_and_wait "${BINARY} tx gateway init-session \
    --executor \"$(get_addr ${EXECUTOR_KEY})\" \
    --fragment-size \"${FRAGMENT_SIZE}\" \
    --from \"${OWNER_KEY}\" \
    --keyring-backend test \
    --chain-id \"${CHAIN_ID}\" \
    --node \"${NODE_URL}\" \
    --broadcast-mode sync \
    -y -o json")

  # イベントログから session_id を抽出
  SESSION_ID=$(echo "${init_res}" | jq -r '.events[]? | select(.type=="csu_init_session") | .attributes[]? | select(.key=="session_id") | .value' | head -n1)
  
  # イベントに含まれていない場合、レスポンスデータから抽出を試みる (フォールバック)
  if [[ -z "${SESSION_ID}" || "${SESSION_ID}" == "null" ]]; then
    SESSION_ID=$(echo "${init_res}" | jq -r '.data? // empty' | head -n1)
  fi

  if [[ -z "${SESSION_ID}" || "${SESSION_ID}" == "null" ]]; then
    echo "InitSession レスポンス:" >&2
    echo "${init_res}" >&2
    fail "InitSession トランザクションから session_id を抽出できませんでした"
  fi

  log "セッションID: ${SESSION_ID}"
}

# Step 4: Pythonスクリプトによる証明書・マニフェスト生成
generate_proofs_and_manifest() {
  log "CSU RootProof, 各種証明, items.json, manifest.json を生成中 (オフライン処理)"

  local owner_addr
  owner_addr="$(get_addr ${OWNER_KEY})"

  # Pythonスクリプトへ渡す環境変数をエクスポート
  export TEST_DIR FRAGMENT_SIZE SESSION_ID PROJECT_NAME PROJECT_VERSION 
  export ITEMS_JSON MANIFEST_JSON ROOT_PROOF_FILE FDSC_CHANNELS
  export OWNER_ADDR="${owner_addr}"

  # Pythonスクリプト実行
  python3 - <<'PY'
import base64
import hashlib
import json
import mimetypes
import os
import sys

# 環境変数の読み込み
TEST_DIR = os.environ["TEST_DIR"]
FRAGMENT_SIZE = int(os.environ["FRAGMENT_SIZE"])
SESSION_ID = os.environ["SESSION_ID"]
OWNER_ADDR = os.environ["OWNER_ADDR"]
PROJECT_NAME = os.environ["PROJECT_NAME"]
PROJECT_VERSION = os.environ["PROJECT_VERSION"]
ITEMS_JSON = os.environ["ITEMS_JSON"]
MANIFEST_JSON = os.environ["MANIFEST_JSON"]
ROOT_PROOF_FILE = os.environ["ROOT_PROOF_FILE"]
FDSC_CHANNELS = os.environ.get("FDSC_CHANNELS", "").split()


def sha256(b: bytes) -> bytes:
    """SHA256ハッシュを計算する"""
    return hashlib.sha256(b).digest()


def hash_fragment_leaf(path: str, index: int, fragment_bytes: bytes) -> bytes:
    """フラグメント(葉ノード)のハッシュを計算する"""
    frag_digest_hex = sha256(fragment_bytes).hex()
    payload = f"FRAG:{path}:{index}:{frag_digest_hex}".encode("utf-8")
    return sha256(payload)


def hash_file_leaf(path: str, file_size: int, file_root: bytes) -> bytes:
    """ファイル(中間ルート)のハッシュを計算する"""
    payload = f"FILE:{path}:{file_size}:{file_root.hex()}".encode("utf-8")
    return sha256(payload)


def merkle_parent(l: bytes, r: bytes) -> bytes:
    """2つの子ノードから親ノードのハッシュを計算する"""
    return sha256(l + r)


def merkle_root(leaves: list[bytes]) -> bytes:
    """Merkle Rootを計算する"""
    if not leaves:
        raise ValueError("葉ノードが空です")
    level = list(leaves)
    while len(level) > 1:
        # 要素数が奇数の場合、最後の要素を複製する
        if len(level) % 2 == 1:
            level.append(level[-1])
        nxt = []
        for i in range(0, len(level), 2):
            nxt.append(merkle_parent(level[i], level[i + 1]))
        level = nxt
    return level[0]


def merkle_proof(leaves: list[bytes], leaf_index: int) -> list[dict]:
    """指定されたインデックスのMerkle Proof(証明パス)を生成する"""
    if not leaves:
        raise ValueError("葉ノードが空です")
    if leaf_index < 0 or leaf_index >= len(leaves):
        raise IndexError("インデックスが範囲外です")

    steps: list[dict] = []
    idx = leaf_index
    level = list(leaves)
    while len(level) > 1:
        if len(level) % 2 == 1:
            level.append(level[-1])
        
        # 兄弟ノードのインデックスを計算 (XOR 1)
        sib = idx ^ 1
        sibling = level[sib]
        steps.append({
            "sibling_hex": sibling.hex(),
            "sibling_is_left": sib < idx,
        })
        
        # 次のレベルへ
        nxt = []
        for i in range(0, len(level), 2):
            nxt.append(merkle_parent(level[i], level[i + 1]))
        level = nxt
        idx //= 2
    return steps


def normalize_relpath(root: str, path: str) -> str:
    """相対パスを正規化する"""
    rel = os.path.relpath(path, root)
    rel = rel.replace("\\", "/")
    rel = rel.lstrip("./")
    return rel


def fragment_id(session_id: str, path: str, index: int) -> str:
    """フラグメントを一意に識別するIDを生成する"""
    # 決定論的かつJSONセーフな識別子
    # (FDSC側もこのルールで保存している前提)
    return f"{session_id}:{path}:{index}"


# ファイル収集 (決定論的な順序にするためソート)
paths: list[str] = []
for dirpath, _, filenames in os.walk(TEST_DIR):
    for fn in filenames:
        full = os.path.join(dirpath, fn)
        paths.append(full)

paths = sorted(paths, key=lambda p: normalize_relpath(TEST_DIR, p))
if not paths:
    raise SystemExit("ファイルが見つかりません")

# ファイルごとのフラグメント葉ノードと証明の構築
file_entries = []  # 各要素: {path, size, fragments, frag_leaves, file_root, file_leaf}

for full in paths:
    rel = normalize_relpath(TEST_DIR, full)
    data = open(full, "rb").read()
    size = len(data)
    
    # 指定サイズで分割
    fragments = [data[i:i + FRAGMENT_SIZE] for i in range(0, size, FRAGMENT_SIZE)]
    if not fragments:
        fragments = [b""]
        
    # 各フラグメントのハッシュ計算
    frag_leaves = [hash_fragment_leaf(rel, i, frag) for i, frag in enumerate(fragments)]
    # ファイルごとのルート計算
    froot = merkle_root(frag_leaves)
    # ファイル自体の葉ノード計算
    fleaf = hash_file_leaf(rel, size, froot)
    
    file_entries.append({
        "path": rel,
        "size": size,
        "fragments": fragments,
        "frag_leaves": frag_leaves,
        "file_root": froot,
        "file_leaf": fleaf,
    })

# 全ファイルの葉ノードから全体の RootProof を計算
file_leaves = [e["file_leaf"] for e in file_entries]
root_proof = merkle_root(file_leaves)
root_proof_hex = root_proof.hex()

# ファイル証明 (ファイル内の全フラグメントで共通)
file_proofs_by_path: dict[str, list[dict]] = {}
for i, e in enumerate(file_entries):
    file_proofs_by_path[e["path"]] = merkle_proof(file_leaves, i)

# DistributeBatch用のアイテムリスト作成 (決定論的順序: path昇順, index昇順)
items = []
rr = 0
for e in file_entries:
    rel = e["path"]
    fsize = e["size"]
    fproof_steps = file_proofs_by_path[rel]
    for idx, frag in enumerate(e["fragments"]):
        fp_steps = merkle_proof(e["frag_leaves"], idx)
        items.append({
            "path": rel,
            "index": idx,
            "fragment_bytes_base64": base64.b64encode(frag).decode("ascii"),
            "fragment_proof": {"steps": fp_steps},
            "file_size": fsize,
            "file_proof": {"steps": fproof_steps},
        })
        rr += 1

# マニフェスト作成 (GWCと同じラウンドロビンルールでフラグメントをFDSCチャンネルに割り当て)
files_map: dict[str, dict] = {}
rr = 0
for e in file_entries:
    rel = e["path"]
    mime, _ = mimetypes.guess_type(rel)
    if not mime:
        mime = "application/octet-stream"

    frags = []
    for idx, frag in enumerate(e["fragments"]):
        fdsc_id = (FDSC_CHANNELS[rr % len(FDSC_CHANNELS)] if FDSC_CHANNELS else "")
        frags.append({
            "fdsc_id": fdsc_id,
            "fragment_id": fragment_id(SESSION_ID, rel, idx),
        })
        rr += 1

    files_map[rel] = {
        "mime_type": mime,
        "size": e["size"],
        "fragments": frags,
        "file_root": e["file_root"].hex(),
    }

manifest = {
    "project_name": PROJECT_NAME,
    "version": PROJECT_VERSION,
    "files": files_map,
    "root_proof": root_proof_hex,
    "fragment_size": FRAGMENT_SIZE,
    "owner": OWNER_ADDR,
    "session_id": SESSION_ID,
}

# JSONファイルの書き出し
with open(ITEMS_JSON, "w", encoding="utf-8") as f:
    json.dump({"items": items}, f, ensure_ascii=False, indent=2)

with open(MANIFEST_JSON, "w", encoding="utf-8") as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)

with open(ROOT_PROOF_FILE, "w", encoding="utf-8") as f:
    f.write(root_proof_hex + "\n")

# 標準出力へRootProofを出力 (シェル側で受け取るため)
print(root_proof_hex)
PY

  ROOT_PROOF_HEX="$(cat "${ROOT_PROOF_FILE}" | tr -d '\n')"
  log "RootProof (hex): ${ROOT_PROOF_HEX}"
}

# Step 5: RootProof のコミット (CommitRootProof)
commit_root_proof() {
  log "RootProof をコミットします"
  execute_tx_and_wait "${BINARY} tx gateway commit-root-proof \"${SESSION_ID}\" \"${ROOT_PROOF_HEX}\" \
    --from \"${OWNER_KEY}\" \
    --keyring-backend test \
    --chain-id \"${CHAIN_ID}\" \
    --node \"${NODE_URL}\" \
    --broadcast-mode sync \
    -y -o json" >/dev/null
}

# Step 6: バッチ配信 (DistributeBatch)
distribute_batch() {
  log "バッチ配信 (全フラグメント) を実行します"
  execute_tx_and_wait "${BINARY} tx gateway distribute-batch \"${SESSION_ID}\" \"${ITEMS_JSON}\" \
    --from \"${EXECUTOR_KEY}\" \
    --keyring-backend test \
    --chain-id \"${CHAIN_ID}\" \
    --node \"${NODE_URL}\" \
    --broadcast-mode sync \
    -y -o json" >/dev/null
}

# Step 7: 重複配信の拒否テスト
test_duplicate_rejection() {
  log "サニティチェック: 重複したフラグメント配信が拒否されるか確認します"
  
  set +e # 一時的にエラー停止を無効化
  ${BINARY} tx gateway distribute-batch "${SESSION_ID}" "${ITEMS_JSON}" \
    --from "${EXECUTOR_KEY}" \
    --keyring-backend test \
    --chain-id "${CHAIN_ID}" \
    --node "${NODE_URL}" \
    -y -o json >/dev/null 2>&1
  local dup_rc=$?
  set -e # エラー停止を再度有効化

  if [[ "${dup_rc}" -eq 0 ]]; then
    fail "重複フラグメントの配信がエラーになることを期待しましたが、成功してしまいました"
  fi
  log "OK: 重複フラグメントは正しく拒否されました"
}

# Step 8: 状態確認とファイナライズ (FinalizeAndCloseSession)
finalize_session() {
  log "フラグメントのACK到着を待機しています (数秒待ちます)..."
  sleep 3

  log "セッションの状態とカウンターを確認します"
  ${BINARY} q gateway session "${SESSION_ID}" --node "${NODE_URL}" -o json > "${SESSION_JSON}" || true
  if [[ -s "${SESSION_JSON}" ]]; then
    local distributed ack_ok ack_err state
    distributed=$(jq -r '.session.distributed_count // 0' "${SESSION_JSON}")
    ack_ok=$(jq -r '.session.ack_success_count // 0' "${SESSION_JSON}")
    ack_err=$(jq -r '.session.ack_error_count // 0' "${SESSION_JSON}")
    state=$(jq -r '.session.state // ""' "${SESSION_JSON}")
    log "セッション状態=${state}, 配信数=${distributed}, ACK成功=${ack_ok}, ACK失敗=${ack_err}"
  fi

  log "FinalizeAndCloseSession を実行し、MDSCへマニフェストを送信します"
  execute_tx_and_wait "${BINARY} tx gateway finalize-and-close \"${SESSION_ID}\" \"${MANIFEST_JSON}\" \
    --from \"${EXECUTOR_KEY}\" \
    --keyring-backend test \
    --chain-id \"${CHAIN_ID}\" \
    --node \"${NODE_URL}\" \
    --broadcast-mode sync \
    -y -o json" >/dev/null
}

# Step 9: MDSC側の状態検証
verify_mdsc_state() {
  log "MDSCがマニフェストを保存し、GWCセッションが CLOSED_SUCCESS になるのを待機しています"

  local mdsc_pod
  mdsc_pod="$(kubectl get pods -n "${NAMESPACE}" -o name 2>/dev/null | sed 's#pod/##' | grep -E '^mdsc-[0-9]+-node-0$' | head -n1 || true)"
  
  if [[ -z "${mdsc_pod}" ]]; then
    log "警告: 名前空間 ${NAMESPACE} に MDSC のPodが見つかりません。MDSCのオンチェーンクエリチェックをスキップします。"
    return
  fi

  # MDSCにマニフェストが反映されるまでポーリング
  local found=false
  for i in $(seq 1 30); do
    if kubectl exec -n "${NAMESPACE}" "${mdsc_pod}" -- /workspace/apps/mdsc/dist/mdscd q metastore get-manifest "${PROJECT_NAME}" -o json >/dev/null 2>&1; then
      found=true
      break
    fi
    sleep 2
  done

  if [[ "${found}" == "false" ]]; then
    fail "待機しましたが、MDSC上にマニフェストが見つかりませんでした"
  fi

  local mdsc_manifest_json
  mdsc_manifest_json=$(kubectl exec -n "${NAMESPACE}" "${mdsc_pod}" -- /workspace/apps/mdsc/dist/mdscd q metastore get-manifest "${PROJECT_NAME}" -o json 2>/dev/null || true)

  # 新旧のフィールド名に対応
  local remote_root remote_fs
  remote_root=$(echo "${mdsc_manifest_json}" | jq -r '.root_proof // .site_root // empty')
  remote_fs=$(echo "${mdsc_manifest_json}" | jq -r '.fragment_size // empty')

  if [[ "${remote_root}" != "${ROOT_PROOF_HEX}" ]]; then
    echo "MDSC マニフェスト内容:" >&2
    echo "${mdsc_manifest_json}" >&2
    fail "MDSC root_proof 不一致: 期待値=${ROOT_PROOF_HEX}, 実際=${remote_root}"
  fi
  if [[ -n "${remote_fs}" && "${remote_fs}" != "${FRAGMENT_SIZE}" ]]; then
    fail "MDSC fragment_size 不一致: 期待値=${FRAGMENT_SIZE}, 実際=${remote_fs}"
  fi
  log "OK: MDSC上のマニフェストとRootProofが一致しました"
}

# Step 10: セッション完了の確認
verify_session_closed() {
  log "MDSCのACKによるセッションクローズを待機しています"
  
  local state=""
  for i in $(seq 1 30); do
    local sess
    sess=$(${BINARY} q gateway session "${SESSION_ID}" --node "${NODE_URL}" -o json 2>/dev/null || true)
    state=$(echo "${sess}" | jq -r '.session.state // empty')
    
    if [[ "${state}" == "SESSION_STATE_CLOSED_SUCCESS" ]]; then
      log "OK: セッションは正常に CLOSED_SUCCESS になりました"
      return 0
    fi
    sleep 2
  done

  echo "最終セッション状態:" >&2
  ${BINARY} q gateway session "${SESSION_ID}" --node "${NODE_URL}" -o json 2>/dev/null || true >&2
  fail "セッションが CLOSED_SUCCESS に到達しませんでした (state=${state})"
}

# Step 11: クローズ済みセッションへの配信拒否テスト
test_closed_session_rejection() {
  log "サニティチェック: クローズ済みセッションへの追加配信が拒否されるか確認します"
  
  set +e
  ${BINARY} tx gateway distribute-batch "${SESSION_ID}" "${ITEMS_JSON}" \
    --from "${EXECUTOR_KEY}" \
    --keyring-backend test \
    --chain-id "${CHAIN_ID}" \
    --node "${NODE_URL}" \
    -y -o json >/dev/null 2>&1
  local closed_rc=$?
  set -e
  
  if [[ "${closed_rc}" -eq 0 ]]; then
    fail "クローズ済みセッションへの配信がエラーになることを期待しましたが、成功してしまいました"
  fi
  log "OK: クローズ済みセッションは正しく配信を拒否しました"
}

# Step 12: FDSC側の保存確認 (ベストエフォート)
verify_fdsc_storage() {
  log "ベストエフォート確認: FDSC上にフラグメントが存在するか検証します"

  local fdsc_pod
  fdsc_pod="$(kubectl get pods -n "${NAMESPACE}" -o name 2>/dev/null | sed 's#pod/##' | grep -E '^fdsc-[0-9]+-node-0$' | head -n1 || true)"
  
  if [[ -z "${fdsc_pod}" ]]; then
    log "警告: 名前空間 ${NAMESPACE} に FDSC のPodが見つかりません。FDSCチェックをスキップします。"
    return
  fi

  # items.json から期待されるフラグメント(Base64)リストを読み込み
  local expected_b64
  mapfile -t expected_b64 < <(jq -r '.items[].fragment_bytes_base64' "${ITEMS_JSON}")

  # FDSCから全フラグメントリストを取得
  local all_frags_json
  all_frags_json=$(kubectl exec -n "${NAMESPACE}" "${fdsc_pod}" -- /workspace/apps/fdsc/dist/fdscd q datastore list-fragment -o json 2>/dev/null || true)

  if [[ -z "${all_frags_json}" ]]; then
    log "警告: FDSCからフラグメント一覧を取得できませんでした。"
  else
    for b64 in "${expected_b64[@]}"; do
      # リスト内に該当データを持つフラグメントIDが存在するかチェック
      if ! echo "${all_frags_json}" | jq -e --arg b64 "${b64}" '.fragment[]? | select(.data==$b64) | .fragment_id' >/dev/null 2>&1; then
        fail "FDSCに期待されるフラグメントペイロードが含まれていません (base64先頭=${b64:0:16}...)"
      fi
    done
    log "OK: FDSCは全てのフラグメントペイロードを保持しています (リストスキャンにより確認)"
  fi
}

# ------------------------------------------------------------------------------
# 4. メイン実行フロー
# ------------------------------------------------------------------------------

main() {
  create_test_files
  discover_storage_channels
  init_session
  generate_proofs_and_manifest
  commit_root_proof
  distribute_batch
  test_duplicate_rejection
  finalize_session
  verify_mdsc_state
  verify_session_closed
  test_closed_session_rejection
  verify_fdsc_storage

  log "CSU 整合性テストは正常に完了しました。"
}

# スクリプト実行
main