#!/bin/bash
# ops/scripts/test/external/phase4/lib/common.sh

# グローバル共通ライブラリの読み込み
source "$(dirname "${BASH_SOURCE[0]}")/../../../../lib/common.sh"

# 定数
GWC_POD=$(get_chain_pod_name "gwc")
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

# アップロード実行 & 完了待機 (Relayerログ追従機能付き)
upload_and_wait() {
    local file_path=$1 
    local target_chain=$2
    local timeout=180 # 1MB以上のデータ処理用にタイムアウトを延長

    log_step "📤 Uploading $(basename "$file_path") (Content of $file_path)..."
    
    # ログの読み出し開始位置を取得
    local start_line=$(pod_exec "$RELAYER_POD" sh -c "wc -l < $LOG_FILE" || echo "0")
    local current_line=$((start_line + 1))

    # Tx送信
    local cmd="gwcd tx gateway upload $(basename "$file_path") @$file_path --from $MILLIONAIRE_KEY --chain-id gwc -y --output json --keyring-backend test --home /home/gwc/.gwc"
    
    local res=$(pod_exec "$GWC_POD" $cmd)
    local tx_hash=$(echo "$res" | jq -r '.txhash')
    
    if [ -z "$tx_hash" ] || [ "$tx_hash" == "null" ]; then
        log_error "Upload failed: $res"
    fi
    log_info "TxHash: $tx_hash"

    log_info "⏳ Waiting for IBC Acknowledgement (Streaming Relayer Logs)..."
    local success=false
    
    # ログ監視ループ
    for ((i=1; i<=timeout; i+=2)); do
        # 前回の続きからログを取得
        local new_logs=$(pod_exec "$RELAYER_POD" sh -c "tail -n +$current_line $LOG_FILE 2>/dev/null" || true)
        
        if [ -n "$new_logs" ]; then
            # 取得したログを表示 (色付きでRelayerログであることを明示)
            echo -e "\033[0;90m$new_logs\033[0m"
            
            # 次回の読み出し開始位置を更新
            local line_count=$(echo "$new_logs" | wc -l)
            current_line=$((current_line + line_count))
            
            # 成功判定
            if echo "$new_logs" | grep -q "MsgAcknowledgement"; then
                success=true
                break
            fi
        fi
        
        sleep 2
    done

    if [ "$success" = false ]; then
        log_error "Timeout waiting for IBC packet relay."
    fi
    log_success "IBC Packet relayed successfully."
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
    log_info "   - Size: $orig_size bytes"
    log_info "   - MD5:  $orig_hash"

    # 2. MDSC (Metadata) の確認と表示
    log_info "📋 [MDSC Data Structure (Manifests)]"
    local mdsc_json=$(pod_exec "$MDSC_POD" mdscd q metastore list-manifest -o json)
    echo "$mdsc_json" | jq '.'
    echo "----------------------------------------"

    # 3. FDSC (File Data) の確認と表示
    log_info "📦 [FDSC ($target_chain) Data Structure (Fragments)]"
    local fdsc_json=$(pod_exec "$fdsc_pod" fdscd q datastore list-fragment -o json)
    echo "$fdsc_json" | jq '.'
    echo "----------------------------------------"

    # 断片数チェック
    local frag_count=$(echo "$fdsc_json" | jq '.fragment | length')
    if [ "$frag_count" -eq 0 ]; then
        log_error "No fragments found on FDSC."
    fi

    # 最新のフラグメントデータを取得
    local content_base64=$(echo "$fdsc_json" | jq -r '.fragment[-1].data')

    if [ -z "$content_base64" ] || [ "$content_base64" == "null" ]; then
        log_error "Failed to extract data from fragment."
    fi

    # 4. 復元と検証
    local restored_path="/tmp/restored_$(basename "$original_local_path")"
    
    # Base64デコード
    if ! echo "$content_base64" | base64 -d > "$restored_path"; then
        log_error "Base64 decode failed."
    fi

    local rest_size=$(wc -c < "$restored_path")
    local rest_hash=$(calc_hash "$restored_path")
    
    log_info "🔄 Restored File: $restored_path"
    log_info "   - Size: $rest_size bytes"
    log_info "   - MD5:  $rest_hash"

    # 5. 比較
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
        log_warn "❌ Data Verification FAIL: Hash mismatch!"
        
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