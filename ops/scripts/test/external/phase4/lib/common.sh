#!/bin/bash
# ops/scripts/test/external/phase4/lib/common.sh

set -uo pipefail

# グローバル共通ライブラリの読み込み
source "$(dirname "${BASH_SOURCE[0]}")/../../../../lib/common.sh"

# 定数
GWC_POD=$(get_chain_pod_name "gwc")
RELAYER_POD=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/component=relayer" -o jsonpath="{.items[0].metadata.name}")
MDSC_POD=$(get_chain_pod_name "mdsc")

# =============================================================================
# 🛠️ Helper Functions
# =============================================================================

create_html_file() {
  local filepath=$1
  local title=$2
  echo "<!DOCTYPE html><html><head><title>$title</title></head><body><h1>Hello $title</h1><p>Random: $RANDOM</p></body></html>" > "$filepath"
}

calc_hash() {
  local filepath=$1
  if [ ! -f "$filepath" ]; then echo "missing"; return; fi
  if command -v md5sum >/dev/null; then
    md5sum "$filepath" | awk '{print $1}'
  else
    md5 -q "$filepath"
  fi
}

push_to_gwc() {
  local src=$1
  local dst=$2 
  kubectl cp "$src" "$NAMESPACE/$GWC_POD:$dst" -c chain
}

upload_and_get_txhash() {
    local file_path=$1
    local project_name=${2:-"default-project"}
    local version=${3:-"v1.0.0"}
    local fragment_size=${4:-0} # 0 means default
    local tx_hash=""

    log_step "📤 Submitting Upload Tx for $(basename "$file_path")..."
    log_info "   Project: $project_name, Version: $version, FragSize: $fragment_size"
    
    local cmd="gwcd tx gateway upload $(basename "$file_path") @$file_path \
        --project-name $project_name \
        --version $version \
        --fragment-size $fragment_size \
        --from $MILLIONAIRE_KEY --chain-id gwc -y --output json --keyring-backend test --home /home/gwc/.gwc --gas auto --gas-adjustment 1.2"
    
    local res=$(pod_exec "$GWC_POD" $cmd)
    
    # 修正: JSON部分のみを抽出 (ログ混入対策)
    tx_hash=$(echo "$res" | sed -n '/^{/,$p' | jq -r '.txhash')
    
    if [ -z "$tx_hash" ] || [ "$tx_hash" == "null" ]; then
        log_error "Upload transaction failed: $res"
    fi
    log_info "TxHash: $tx_hash"
    
    echo "$tx_hash"
}

upload_and_wait_v2() {
    local remote_path=$1
    local target_chain=$2 
    local project_name=$3
    local version=$4
    local fragment_size=$5

    local tx_hash=$(upload_and_get_txhash "$remote_path" "$project_name" "$version" "$fragment_size")
    
    sleep 6
    wait_for_data_persistence "$target_chain" "$project_name"
}

wait_for_data_persistence() {
    local target_chain=$1
    local project_name=$2
    local timeout=180
    
    local fdsc_pod=$(kubectl get pods -n "$NAMESPACE" -l "app.kubernetes.io/name=fdsc" -o jsonpath="{.items[0].metadata.name}" 2>/dev/null)
    if [ -z "$fdsc_pod" ]; then
        fdsc_pod=$(get_chain_pod_name "$target_chain")
    fi
    
    log_info "⏳ Waiting for Data Persistence..."
    if [ -n "$project_name" ]; then
        log_info "   Target Project: $project_name"
    fi
    
    local persistence_success=false
    
    for ((i=1; i<=timeout/2; i++)); do
        local fdsc_out=$(pod_exec "$fdsc_pod" fdscd q datastore list-fragment -o json 2>/dev/null)
        local fdsc_count=$(echo "$fdsc_out" | sed -n '/^{/,$p' | jq '.fragment | length' 2>/dev/null)
        if [ -z "$fdsc_count" ]; then fdsc_count=0; fi
        
        local mdsc_out=$(pod_exec "$MDSC_POD" mdscd q metastore list-manifest -o json 2>/dev/null)
        local mdsc_json=$(echo "$mdsc_out" | sed -n '/^{/,$p') # JSON抽出
        local mdsc_found=false

        if [ -n "$project_name" ]; then
            local found_count=$(echo "$mdsc_json" | jq -r --arg proj "$project_name" '.manifest[] | select(.project_name == $proj) | .project_name' 2>/dev/null | wc -l | tr -d ' ')
            if [ "$found_count" -gt 0 ]; then
                mdsc_found=true
            fi
        else
            local total_count=$(echo "$mdsc_json" | jq '.manifest | length' 2>/dev/null)
            if [ -n "$total_count" ] && [ "$total_count" -gt 0 ]; then
                mdsc_found=true
            fi
        fi
        
        if [ "$fdsc_count" -gt 0 ] && [ "$mdsc_found" = true ]; then
            log_success "Data Persistence Confirmed! (Fragments: $fdsc_count, Project Found: $mdsc_found)"
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

debug_dump_all_storage() {
    echo ""
    log_warn "🐛 [DEBUG] Dumping Storage State for troubleshooting..."
    local fdsc_pods=$(kubectl get pods -n "$NAMESPACE" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | grep "fdsc")
    if [ -z "$fdsc_pods" ]; then
        log_warn "No FDSC pods found!"
        return
    fi
    for pod in $fdsc_pods; do
        echo "---------------------------------------------------"
        log_info "📦 Storage Node: $pod"
        local fragments_out=$(pod_exec "$pod" fdscd q datastore list-fragment -o json 2>/dev/null)
        local fragments=$(echo "$fragments_out" | sed -n '/^{/,$p')
        local count=$(echo "$fragments" | jq '.fragment | length' 2>/dev/null || echo "0")
        log_info "   Total Fragments: $count"
        if [ "$count" -gt 0 ]; then
            echo "$fragments" | jq -c '.fragment[] | {id: .fragment_id, creator: .creator}' | tail -n 5
            echo "   ... (showing last 5 entries)"
        fi
    done
    echo "---------------------------------------------------"
    echo ""
}

verify_data() {
  local default_chain=$1 
  local original_local_path=$2
  local manifest_key=$3
  local project_name=$4
  
  if [ -z "$project_name" ]; then
    log_error "verify_data requires project_name as 4th argument"
  fi

  # K8sの状態をまず表示
  # debug_dump_k8s_state

  log_step "🔍 Verifying data for '$manifest_key' in project '$project_name'..."

  local orig_size=$(wc -c < "$original_local_path")
  local orig_hash=$(calc_hash "$original_local_path")
  log_info "📄 Original File: $original_local_path"
  log_info "  - Size: $orig_size bytes"
  log_info "  - MD5: $orig_hash"

  # MDSC取得
  local mdsc_out=$(pod_exec "$MDSC_POD" mdscd q metastore list-manifest -o json)
  local mdsc_json=$(echo "$mdsc_out" | sed -n '/^{/,$p') # JSON抽出
  
  local fragments_json=$(echo "$mdsc_json" | jq -c --arg proj "$project_name" --arg key "$manifest_key" \
    '.manifest[] | select(.project_name == $proj) | .files[$key].fragments' 2>/dev/null)
  
  if [ -z "$fragments_json" ] || [ "$fragments_json" == "null" ]; then
    log_error "Failed to retrieve fragments for key '$manifest_key'."
    exit 1
  fi
  
  local frag_count=$(echo "$fragments_json" | jq 'length')
  log_info "   Target has $frag_count fragments."

  local restored_path="/tmp/restored_$(basename "$original_local_path")"
  local all_content_base64=""
  
  for (( i=0; i<$frag_count; i++ )); do
    local frag_entry=$(echo "$fragments_json" | jq -c ".[$i]")
    local frag_id=$(echo "$frag_entry" | jq -r '.fragment_id')
    local fdsc_channel=$(echo "$frag_entry" | jq -r '.fdsc_id')

    # Pod名解決ロジック
    local chain_suffix=${fdsc_channel#channel-}
    local target_chain_name="fdsc-${chain_suffix}"
    local target_pod=$(get_chain_pod_name "$target_chain_name")
    
    if [ -z "$target_pod" ]; then
        target_pod=$(kubectl get pods -n "$NAMESPACE" | grep "fdsc" | grep "\-${chain_suffix}-" | awk '{print $1}' | head -n 1)
        if [ -z "$target_pod" ]; then
             target_pod=$(kubectl get pods -n "$NAMESPACE" | grep "fdsc" | grep "\-${chain_suffix}$" | awk '{print $1}' | head -n 1)
        fi
    fi
    
    log_info "   - Fetching Fragment $i (ID: $frag_id)"
    log_info "     Expectation: Channel=$fdsc_channel -> Chain=$target_chain_name -> Pod=$target_pod"

    if [ -z "$target_pod" ] || ! kubectl get pod -n "$NAMESPACE" "$target_pod" >/dev/null 2>&1; then
        log_error "CRITICAL: Target pod '$target_pod' DOES NOT EXIST."
        exit 1
    fi

    # --- リトライ付きクエリ実行 ---
    local frag_data_json=""
    local retry_count=0
    local max_retries=20 # 3s * 20 = 60s wait
    local query_success=false

    while [ $retry_count -lt $max_retries ]; do
        set +e
        local raw_out=$(pod_exec "$target_pod" fdscd q datastore get-fragment "$frag_id" -o json 2>&1)
        local exit_code=$?
        set -e
        
        # JSON部分のみ抽出
        frag_data_json=$(echo "$raw_out" | sed -n '/^{/,$p')

        if [ $exit_code -eq 0 ] && [ -n "$frag_data_json" ] && ! echo "$raw_out" | grep -q "key not found"; then
            query_success=true
            break
        fi

        log_info "      ⏳ Fragment not found yet (Attempt $((retry_count+1))/$max_retries)... waiting 3s"
        sleep 3
        retry_count=$((retry_count+1))
    done

    if [ "$query_success" = false ]; then
        log_error "❌ DATA MISSING on $target_pod after retries! (ID: $frag_id)"
        debug_dump_all_storage
        exit 1
    fi
    # ----------------------------

    local content_base64=$(echo "$frag_data_json" | jq -r '.fragment.data')
    if [ -z "$content_base64" ] || [ "$content_base64" == "null" ]; then
      log_error "Failed to extract data json."
      exit 1
    fi
    
    all_content_base64+="$content_base64"
  done
  
  if ! echo "$all_content_base64" | base64 -d > "$restored_path"; then
    log_error "Combined Base64 decode failed."
  fi

  local rest_hash=$(calc_hash "$restored_path")
  local rest_size=$(wc -c < "$restored_path")
  
  log_info "🔄 Restored File: $restored_path"
  log_info "  - Size: $rest_size bytes"
  log_info "  - MD5: $rest_hash"

  if [ "$orig_hash" == "$rest_hash" ]; then
        log_success "Data Verification PASS: Hashes match ($orig_hash)"
        rm -f "$restored_path"
    else
        log_warn "❌ Data Verification FAIL: Hash mismatch!"
        exit 1
    fi
}