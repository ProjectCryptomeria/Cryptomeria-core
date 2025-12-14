#!/bin/bash
# ops/scripts/test/external/phase4/lib/common.sh

# グローバル共通ライブラリの読み込み
source "$(dirname "${BASH_SOURCE[0]}")/../../../../lib/common.sh"

# 定数
GWC_POD=$(get_chain_pod_name "gwc")

# ▼▼▼ 修正: RelayerはDeploymentなのでラベルで検索する ▼▼▼
RELAYER_POD=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")

LOG_FILE="/home/relayer/.relayer/relayer.log"
MDSC_POD=$(get_chain_pod_name "mdsc")

# =============================================================================
# 🛠️ Helper Functions
# =============================================================================

# テストデータの生成 (HTML)
create_html_file() {
    local filepath=$1
    local title=$2
    echo "<!DOCTYPE html><html><head><title>$title</title></head><body><h1>Hello $title</h1><p>Random: $RANDOM</p></body></html>" > "$filepath"
}

# ファイルのハッシュ値を計算 (md5sum)
calc_hash() {
    local filepath=$1
    if [ ! -f "$filepath" ]; then echo "missing"; return; fi
    # Linux/Mac両対応 (md5sum or md5)
    if command -v md5sum >/dev/null; then
        md5sum "$filepath" | awk '{print $1}'
    else
        md5 -q "$filepath"
    fi
}

# ファイルをコンテナにコピー
push_to_gwc() {
    local src=$1
    local dst=$2 # GWCコンテナ内のパス
    kubectl cp "$src" "$NAMESPACE/$GWC_POD:$dst" -c chain
}

# アップロード実行 & 完了待機
upload_and_wait() {
    local file_path=$1  # GWCコンテナ内のパス
    local target_chain=$2
    local timeout=60

    log_step "📤 Uploading $(basename "$file_path") to $target_chain..."
    
    # ログの現在位置を取得
    local start_line=$(pod_exec "$RELAYER_POD" sh -c "wc -l < $LOG_FILE" || echo "0")
    start_line=$((start_line + 1))

    # Tx送信
    local cmd="gwcd tx gateway upload $file_path $target_chain --from $MILLIONAIRE_KEY --chain-id gwc -y --output json --keyring-backend test --home /home/gwc/.gwc"
    local res=$(pod_exec "$GWC_POD" $cmd)
    local tx_hash=$(echo "$res" | jq -r '.txhash')
    
    if [ -z "$tx_hash" ] || [ "$tx_hash" == "null" ]; then
        log_error "Upload failed: $res"
    fi
    log_info "TxHash: $tx_hash"

    # Relayerログ監視 (Ack待ち)
    log_info "⏳ Waiting for IBC Acknowledgement..."
    local success=false
    for ((i=1; i<=timeout; i+=2)); do
        local logs=$(pod_exec "$RELAYER_POD" sh -c "tail -n +$start_line $LOG_FILE 2>/dev/null" || true)
        if echo "$logs" | grep -q "MsgAcknowledgement"; then
            success=true
            break
        fi
        sleep 2
    done

    if [ "$success" = false ]; then
        log_error "Timeout waiting for IBC packet relay."
    fi
    log_success "IBC Packet relayed successfully."
}

# データの検証 (FDSCからダウンロードしてハッシュ比較)
verify_data() {
    local target_chain=$1
    local original_local_path=$2
    
    local fdsc_pod=$(get_chain_pod_name "$target_chain")
    log_step "🔍 Verifying data on $target_chain..."

    # 最新のフラグメントを取得してデコード
    # 【重要】フィールド名は .data (proto定義準拠)
    local json=$(pod_exec "$fdsc_pod" fdscd q datastore list-fragment -o json)
    local content_base64=$(echo "$json" | jq -r '.fragment[-1].data') 

    if [ -z "$content_base64" ] || [ "$content_base64" == "null" ]; then
        log_error "No data found on $target_chain"
    fi

    # ローカルで復元して比較
    local restored_path="/tmp/restored_$(basename "$original_local_path")"
    echo "$content_base64" | base64 -d > "$restored_path"

    local hash_orig=$(calc_hash "$original_local_path")
    local hash_rest=$(calc_hash "$restored_path")

    if [ "$hash_orig" == "$hash_rest" ]; then
        log_success "Data Verification PASS: Hashes match ($hash_orig)"
        rm -f "$restored_path"
    else
        log_error "Data Verification FAIL: Hash mismatch! (Orig: $hash_orig, Restored: $hash_rest)"
    fi
}