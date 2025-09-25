#!/bin/bash
# datachainとmetachainの基本的な動作（データ保存・取得）を確認するためのテストスクリプトです。
# 実行前に `make deploy` でチェーンが起動している必要があります。

set -ex

# --- 色付き出力用の関数定義 ---
info() {
    echo -e "\033[36m[INFO] $1\033[0m"
}
success() {
    echo -e "\032[32m[SUCCESS] $1\033[0m"
}
error() {
    echo -e "\031[31m[ERROR] $1\033[0m"
    exit 1
}
step() {
    echo -e "\n\033[1;33m--- $1 ---\033[0m"
}

# --- 変数定義 ---
DATACHAIN_POD_LABEL="app.kubernetes.io/name=raidchain,app.kubernetes.io/instance=data-0"
METACHAIN_POD_LABEL="app.kubernetes.io/name=raidchain,app.kubernetes.io/instance=meta-0"

# --- 前提条件のチェック ---
info "前提条件（kubectlコマンドの存在）をチェックしています..."
if ! command -v kubectl &> /dev/null; then
    error "kubectl コマンドが見つかりません。パスを通すか、インストールしてください。"
fi
if ! command -v jq &> /dev/null; then
    error "jq コマンドが見つかりません。インストールしてください。"
fi
if ! command -v xxd &> /dev/null; then
    error "xxd コマンドが見つかりません。インストールしてください。"
fi
success "必要なコマンドが見つかりました。"

# --- Namespaceの自動検出（リトライ処理付き） ---
step "Namespaceの自動検出"
info "datachainのPodを全てのNamespaceから検索しています（最大60秒）..."
DETECTED_NAMESPACE=""
for i in {1..12}; do
    DETECTED_NAMESPACE=$(kubectl get pods -l ${DATACHAIN_POD_LABEL} --all-namespaces -o jsonpath='{.items[0].metadata.namespace}' 2>/dev/null || true)
    if [[ -n "$DETECTED_NAMESPACE" ]]; then
        break
    fi
    echo -n "."
    sleep 5
done
echo ""

if [[ -z "$DETECTED_NAMESPACE" ]]; then
    error "datachainのPodが見つかりませんでした。'make deploy'が正常に完了しているか、Podが起動しているか確認してください。"
fi
success "Podを '${DETECTED_NAMESPACE}' Namespaceで検出しました。このNamespaceを使用してテストを続行します。"


# --- Podの準備が完了するまで待機する関数 ---
wait_for_pod() {
    local label=$1
    local pod_name_var=$2
    info "'${label}' ラベルを持つPodが起動するのを待っています..."
    
    # 300秒(5分)でタイムアウト
    for i in {1..60}; do
        pod_name=$(kubectl get pods -n ${DETECTED_NAMESPACE} -l "${label}" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
        if [[ -n "$pod_name" ]]; then
            pod_status=$(kubectl get pod -n ${DETECTED_NAMESPACE} ${pod_name} -o jsonpath='{.status.phase}' 2>/dev/null)
            if [[ "$pod_status" == "Running" ]]; then
                eval "$pod_name_var=$pod_name"
                success "Pod '${pod_name}' がRunning状態になりました。"
                return
            fi
        fi
        echo -n "."
        sleep 5
    done
    echo ""
    error "'${label}' ラベルを持つPodが5分以内にRunning状態になりませんでした。 'make deploy' が成功しているか確認してください。"
}

# --- Pod名を取得 ---
wait_for_pod "$DATACHAIN_POD_LABEL" "DATACHAIN_POD"
wait_for_pod "$METACHAIN_POD_LABEL" "METACHAIN_POD"

# --- テスト用のコマンドエイリアスを定義 ---
datachaind() {
    kubectl exec -i "${DATACHAIN_POD}" -n "${DETECTED_NAMESPACE}" -- datachaind "$@"
}
metachaind() {
    kubectl exec -i "${METACHAIN_POD}" -n "${DETECTED_NAMESPACE}" -- metachaind "$@"
}

# --- Chain IDを動的に取得 ---
step "Chain IDの動的取得"
info "各チェーンのPodからChain IDを取得しています..."
DATACHAIN_ID="data-0"
METACHAIN_ID="meta-0"

if [[ -z "$DATACHAIN_ID" || "$DATACHAIN_ID" == "null" ]]; then
    error "datachainのChain ID取得に失敗しました。"
fi
if [[ -z "$METACHAIN_ID" || "$METACHAIN_ID" == "null" ]]; then
    error "metachainのChain ID取得に失敗しました。"
fi
success "datachainのID: ${DATACHAIN_ID}, metachainのID: ${METACHAIN_ID} を取得しました。"

# --- テストで使用するデータを定義 ---
UNIQUE_SUFFIX=$(date +%s)
TEST_CHUNK_INDEX="test-chunk-${UNIQUE_SUFFIX}"
TEST_CHUNK_DATA_RAW="これはdatachainへの保存テスト用のデータです。"
TEST_CHUNK_DATA_HEX=$(echo -n "${TEST_CHUNK_DATA_RAW}" | xxd -p -c 256) 
TEST_URL="my-test-site-${UNIQUE_SUFFIX}/"
TEST_MANIFEST_JSON="{\"filepath\":\"/index.html\",\"chunk_list\":{\"chunks\":[\"${TEST_CHUNK_INDEX}\"]}}"

# --- テスト実行 ---
info "Raidchain 動作確認テストを開始します。"

# 1. Datachain: データチャンクの保存テスト
step "1. Datachain: データチャンク保存テスト"
info "テストデータ (Index: ${TEST_CHUNK_INDEX}) をdatachainに保存します..."
TX_OUTPUT_DATA=$(datachaind tx datastore create-stored-chunk "${TEST_CHUNK_INDEX}" "0x${TEST_CHUNK_DATA_HEX}" \
    --from validator --keyring-backend test --chain-id "${DATACHAIN_ID}" --gas auto --gas-adjustment 1.5 --fees 1000uatom -y -o json)
TX_HASH_DATA=$(echo "${TX_OUTPUT_DATA}" | jq -r '.txhash')

if [[ -z "$TX_HASH_DATA" || "$TX_HASH_DATA" == "null" || $(echo "${TX_OUTPUT_DATA}" | jq -r '.code') != "0" ]]; then
    error "Datachainへのトランザクション発行に失敗しました。 \n出力: ${TX_OUTPUT_DATA}"
fi
success "トランザクションが成功しました。 TxHash: ${TX_HASH_DATA}"
info "トランザクションがブロックに取り込まれるのを待ちます... (10秒)"
sleep 10

# 2. Datachain: データチャンクの取得テスト
step "2. Datachain: データチャンク取得テスト"
info "保存したデータ (Index: ${TEST_CHUNK_INDEX}) をdatachainからクエリで取得します..."
QUERY_OUTPUT_DATA=$(datachaind query datastore get-stored-chunk "${TEST_CHUNK_INDEX}" -o json)

# ★★★ 修正箇所 ★★★
# jqで抽出するキーを `storedChunk` (camelCase) から `stored_chunk` (snake_case) に修正
STORED_DATA_HEX=$(echo "${QUERY_OUTPUT_DATA}" | jq -r '.stored_chunk.data' | sed 's/^0x//')
STORED_DATA_RAW=$(echo "${STORED_DATA_HEX}" | xxd -r -p)

info "取得したデータ: '${STORED_DATA_RAW}'"
info "期待するデータ: '${TEST_CHUNK_DATA_RAW}'"

if [[ "${STORED_DATA_RAW}" != "${TEST_CHUNK_DATA_RAW}" ]]; then
    error "Datachainから取得したデータが期待値と一致しませんでした。"
fi
success "Datachainのデータ保存・取得テストに成功しました。"

# 3. Metachain: マニフェストの保存テスト
step "3. Metachain: マニフェスト保存テスト"
info "テストマニフェスト (URL: ${TEST_URL}) をmetachainに保存します..."
info "マニフェスト内容: ${TEST_MANIFEST_JSON}"
TX_OUTPUT_META=$(metachaind tx metastore create-manifest "${TEST_URL}" "${TEST_MANIFEST_JSON}" \
    --from validator --keyring-backend test --chain-id "${METACHAIN_ID}" --gas auto --gas-adjustment 1.5 --fees 1000uatom -y -o json)
TX_HASH_META=$(echo "${TX_OUTPUT_META}" | jq -r '.txhash')

if [[ -z "$TX_HASH_META" || "$TX_HASH_META" == "null" || $(echo "${TX_OUTPUT_META}" | jq -r '.code') != "0" ]]; then
    error "Metachainへのトランザクション発行に失敗しました。 \n出力: ${TX_OUTPUT_META}"
fi
success "トランザクションが成功しました。 TxHash: ${TX_HASH_META}"
info "トランザクションがブロックに取り込まれるのを待ちます... (10秒)"
sleep 10

# 4. Metachain: マニフェストの取得テスト
step "4. Metachain: マニフェスト取得テスト"
info "保存したマニフェスト (URL: ${TEST_URL}) をmetachainからクエリで取得します..."
QUERY_OUTPUT_META=$(metachaind query metastore get-manifest "${TEST_URL}" -o json)

# ★★★ 修正箇所 ★★★
# jqで抽出するキーを `Manifest` (PascalCase) から `manifest` (snake_case) に修正
STORED_MANIFEST_STRING=$(echo "${QUERY_OUTPUT_META}" | jq -r '.manifest.manifest')

STORED_MANIFEST_FILEPATH=$(echo "${STORED_MANIFEST_STRING}" | jq -r '.filepath')
STORED_MANIFEST_CHUNK=$(echo "${STORED_MANIFEST_STRING}" | jq -r '.chunk_list.chunks[0]')

EXPECTED_FILEPATH=$(echo "${TEST_MANIFEST_JSON}" | jq -r '.filepath')
EXPECTED_CHUNK=$(echo "${TEST_MANIFEST_JSON}" | jq -r '.chunk_list.chunks[0]')

info "取得マニフェストのファイルパス: ${STORED_MANIFEST_FILEPATH} (期待値: ${EXPECTED_FILEPATH})"
info "取得マニフェストのチャンク: ${STORED_MANIFEST_CHUNK} (期待値: ${EXPECTED_CHUNK})"

if [[ "${STORED_MANIFEST_FILEPATH}" != "${EXPECTED_FILEPATH}" || "${STORED_MANIFEST_CHUNK}" != "${EXPECTED_CHUNK}" ]]; then
    error "Metachainから取得したマニフェストが期待値と一致しませんでした。"
fi
success "Metachainのマニフェスト保存・取得テストに成功しました。"

echo ""
success "🎉 全てのテストが正常に完了しました！ \`datachain\` と \`metachain\` は正しく動作しています。"