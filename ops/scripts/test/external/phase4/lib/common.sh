#!/bin/bash
# ops/scripts/test/external/phase4/lib/common.sh

# グローバル共通ライブラリの読み込み
source "$(dirname "${BASH_SOURCE[0]}")/../../../../lib/common.sh"

# 定数
GWC_POD=$(get_chain_pod_name "gwc")
RELAYER_POD=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")
# LOG_FILEは廃止
# LOG_FILE="/home/relayer/.relayer/relayer.log" 
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
  if command -v md5sum >/dev/null; then
    md5sum "$filepath" | awk '{print $1}'
  else
    md5 -q "$filepath"
  fi
}

# ファイルをコンテナにコピー
push_to_gwc() {
  local src=$1
  local dst=$2 
  kubectl cp "$src" "$NAMESPACE/$GWC_POD:$dst" -c chain
}

# 新しい関数: Txを送信し、ハッシュを取得する
upload_and_get_txhash() {
    local file_path=$1 
    local tx_hash=""

    log_step "📤 Submitting Upload Tx for $(basename "$file_path")..."
    
    # Tx送信 (ガス自動推定と調整を使用)
    local cmd="gwcd tx gateway upload $(basename "$file_path") @$file_path --from $MILLIONAIRE_KEY --chain-id gwc -y --output json --keyring-backend test --home /home/gwc/.gwc --gas auto --gas-adjustment 1.2"
    
    # Tx結果を取得
    local res=$(pod_exec "$GWC_POD" $cmd)
    tx_hash=$(echo "$res" | jq -r '.txhash')
    
    if [ -z "$tx_hash" ] || [ "$tx_hash" == "null" ]; then
        log_error "Upload transaction failed: $res"
    fi
    log_info "TxHash: $tx_hash"
    
    # Txハッシュを呼び出し元に返す
    echo "$tx_hash"
}


# 新しい関数: FDSCとMDSCにデータが永続化されるまで待機する
wait_for_data_persistence() {
    local target_chain=$1
    local timeout=180
    local fdsc_pod=$(get_chain_pod_name "$target_chain")
    
    log_info "⏳ Waiting for Data Persistence (Polling FDSC/MDSC)..."
    
    local persistence_success=false
    
    for ((i=1; i<=timeout/2; i++)); do # 2秒間隔でチェック
        # A. FDSC (Data Fragment) の確認
        # Datastoreに断片が1つでもあればOKとする (チャンクの数に関係なく)
        local fdsc_count=$(pod_exec "$fdsc_pod" fdscd q datastore list-fragment -o json 2>/dev/null | jq '.fragment | length' 2>/dev/null || echo "0")
        
        # B. MDSC (Metadata Manifest) の確認
        # Metastoreにマニフェストが1つでもあればOKとする
        local mdsc_count=$(pod_exec "$MDSC_POD" mdscd q metastore list-manifest -o json 2>/dev/null | jq '.manifest | length' 2>/dev/null || echo "0")
        
        if [ "$fdsc_count" -gt 0 ] && [ "$mdsc_count" -gt 0 ]; then
            log_success "Data Persistence Confirmed! (Fragments: $fdsc_count, Manifests: $mdsc_count)"
            persistence_success=true
            break
        fi

        echo -n "."
        sleep 2
    done
    
    if [ "$persistence_success" = false ]; then
        log_error "Timeout waiting for data persistence on storage nodes."
    fi
}


# データの検証 (MDSC/FDSCのJSON確認 + ダウンロードしてハッシュ比較 + 中身表示)
verify_data() {
  local target_chain=$1
  local original_local_path=$2
  
  local fdsc_pod=$(get_chain_pod_name "$target_chain")
  log_step "🔍 Verifying data on $target_chain and MDSC..."

  # 1. オリジナル情報の表示
  local orig_size=$(wc -c < "$original_local_path")
  local orig_hash=$(calc_hash "$original_local_path")
  log_info "📄 Original File: $original_local_path"
  log_info "  - Size: $orig_size bytes"
  log_info "  - MD5: $orig_hash"

  # 2. MDSC (Metadata) の確認と表示
  log_info "📋 [MDSC Data Structure (Manifests)]"
  local mdsc_json=$(pod_exec "$MDSC_POD" mdscd q metastore list-manifest -o json)
  echo "$mdsc_json" | jq '.'
  echo "----------------------------------------"
  
  # 3. 復元処理
  log_info "🔄 Reconstructing file from fragments..."
  local restored_path="/tmp/restored_$(basename "$original_local_path")"
  local all_content_base64=""
  
  # A. マニフェストからフラグメントIDリストを取得
  # ファイル名が index.html であると仮定
  local fragment_ids=$(echo "$mdsc_json" | jq -r '.manifest[0].files["index.html"].fragments[].fragment_id')
  
  if [ -z "$fragment_ids" ]; then
    log_error "Failed to retrieve fragment IDs from MDSC manifest."
  fi
  
  # B. 各フラグメントIDを使ってFDSCからデータを取得し、連結
  local fdsc_bin=$(get_chain_bin_name "$target_chain")
  local fragment_index=0
  
  for frag_id in $fragment_ids; do
    log_info "   - Fetching Fragment $fragment_index (ID: $frag_id)..."
    
    # FDSCから特定IDのフラグメントデータを取得 (fdscd q datastore fragment $frag_id -o json)
    local frag_data_json=$(pod_exec "$fdsc_pod" "$fdsc_bin" q datastore fragment "$frag_id" -o json 2>/dev/null)
    
    # Base64エンコードされたデータ部分を抽出
    local content_base64=$(echo "$frag_data_json" | jq -r '.fragment.data')
    
    if [ -z "$content_base64" ] || [ "$content_base64" == "null" ]; then
      log_error "Failed to extract data for Fragment ID $frag_id."
    fi
    
    # 全てのBase64文字列を連結
    all_content_base64+="$content_base64"
    fragment_index=$((fragment_index + 1))
  done
  
  # C. 全てのBase64データをデコードしてファイルに保存
  if ! echo "$all_content_base64" | base64 -d > "$restored_path"; then
    log_error "Combined Base64 decode failed."
  fi

  local rest_size=$(wc -c < "$restored_path")
  local rest_hash=$(calc_hash "$restored_path")
  
  log_info "🔄 Restored File: $restored_path"
  log_info "  - Size: $rest_size bytes"
  log_info "  - MD5: $rest_hash"

  # 4. 比較 (以下、変更なし)
  if [ "$orig_hash" == "$rest_hash" ]; then
        log_success "Data Verification PASS: Hashes match ($orig_hash)"
        
        # 6. 復元されたデータの中身を表示
        echo ""
        echo "📝 [Restored File Content Preview]"
        echo "========================================"
        
        # 簡易判定: テキストなら表示、バイナリならダンプ
        local is_text=false
        if command -v file >/dev/null; then
            if file "$restored_path" | grep -q "text"; then is_text=true; fi
        else
            case "$restored_path" in
                *.html|*.txt|*.json|*.xml|*.css|*.js|*.md) is_text=true ;;
            esac
        fi

        if [ "$is_text" = true ]; then
            cat "$restored_path" | head -c 2000 # 長すぎる場合は先頭2000文字
            [ "$rest_size" -gt 2000 ] && echo "... (truncated)"
        else
            if command -v xxd >/dev/null; then
                xxd "$restored_path" | head -n 20
                echo "... (Binary data truncated)"
            elif command -v hexdump >/dev/null; then
                hexdump -C "$restored_path" | head -n 20
                echo "... (Binary data truncated)"
            else
                echo "(Binary data - Skipping text output)"
            fi
        fi
        echo ""
        echo "========================================"
        echo ""

        rm -f "$restored_path"
    else
        log_warn "❌ Data Verification FAIL: Hash mismatch! (Original: $orig_hash, Restored: $rest_hash)"
        
        if command -v xxd >/dev/null; then
            echo "--- [Diff: First 128 bytes] ---"
            echo ">> Original:"
            xxd -l 128 "$original_local_path"
            echo ">> Restored:"
            xxd -l 128 "$restored_path"
            echo "-------------------------------"
        fi
        exit 1
    fi
}