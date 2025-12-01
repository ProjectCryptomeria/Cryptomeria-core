#!/bin/bash
set -e

# --- 設定 ---
NAMESPACE="raidchain"
# Relayerアカウントを使用（確実にトークンを持っているため）
USER_NAME="relayer" 
CHAIN_ID_GWC="gwc"
TEST_FILENAME="test-image.png"
TEST_DATA="Hello_RaidChain_This_is_a_test_data_fragment_for_IBC_transfer_verification."
TIMEOUT_SEC=120  # Relayerの接続待ちを含めるため少し長めに

# ユーティリティ関数: ログ出力
log() { echo -e "\033[1;34m[TEST]\033[0m $1"; }
error() { echo -e "\033[1;31m[ERROR]\033[0m $1"; }
success() { echo -e "\033[1;32m[PASS]\033[0m $1"; }

log "🚀 Starting Enhanced PoC Upload Test..."

# Pod名の取得
get_pod() {
    # Podが見つかるまで少し待つリトライ処理
    for i in {1..5}; do
        POD=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/instance=$1 -o jsonpath="{.items[0].metadata.name}" 2>/dev/null)
        if [ -n "$POD" ]; then
            echo "$POD"
            return 0
        fi
        sleep 1
    done
    echo ""
}

GWC_POD=$(get_pod gwc)
MDSC_POD=$(get_pod mdsc)
FDSC_POD=$(get_pod fdsc-0)

if [ -z "$GWC_POD" ] || [ -z "$MDSC_POD" ] || [ -z "$FDSC_POD" ]; then
    error "Failed to find pods. Is the chain deployed?"
    exit 1
fi

# --- 1. 事前チェック: IBCチャネルの状態 (待機ロジック) ---
wait_for_channels() {
    local target_pod=$1
    local expected_count=2 # FDSC + MDSC
    
    log "🔍 Checking IBC Channel Status on GWC..."
    log "⏳ Waiting for at least $expected_count OPEN channels on $target_pod..."
    
    for ((i=1; i<=TIMEOUT_SEC; i+=2)); do
        CHANNELS_JSON=$(kubectl exec -n "$NAMESPACE" "$target_pod" -- gwcd q ibc channel channels -o json 2>/dev/null || echo "{}")
        # jqでSTATE_OPENなチャネルをカウント (.channelsがnullの場合も考慮)
        OPEN_CHANNELS=$(echo "$CHANNELS_JSON" | jq -r '.channels // [] | map(select(.state == "STATE_OPEN")) | length')
        
        if [ "$OPEN_CHANNELS" -ge "$expected_count" ]; then
            echo "" # 改行
            success "IBC Channels are ready! (Found: $OPEN_CHANNELS, Time: ${i}s)"
            # 接続先ポートの確認ログ（デバッグ用）
            echo "$CHANNELS_JSON" | jq -c '.channels[] | {id: .channel_id, port: .counterparty.port_id, state: .state}'
            return 0
        fi
        
        echo -ne "    ... checking channels ($OPEN_CHANNELS/$expected_count) (${i}/${TIMEOUT_SEC}s)\r"
        sleep 2
    done
    echo ""
    error "Timed out waiting for IBC channels. Is Relayer running?"
    return 1
}

# チャネルが開くまで待つ (失敗したらここで終了する)
wait_for_channels "$GWC_POD" || exit 1

# --- 2. ユーザー確認 ---
log "👤 Using user '$USER_NAME' on GWC..."
USER_ADDR=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd keys show $USER_NAME -a --keyring-backend test 2>/dev/null)
echo "    Address: $USER_ADDR"

# --- 3. アップロード実行 ---
log "Hz Sending Upload Transaction..."
TX_RES=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd tx gateway upload "$TEST_FILENAME" "$TEST_DATA" \
    --from $USER_NAME --chain-id $CHAIN_ID_GWC --keyring-backend test -y -o json)

TX_CODE=$(echo "$TX_RES" | jq -r '.code')
TX_HASH=$(echo "$TX_RES" | jq -r '.txhash')

if [ "$TX_CODE" != "0" ]; then
    error "Transaction failed on submission. Raw log:"
    echo "$TX_RES" | jq -r '.raw_log'
    exit 1
fi

log "✅ Tx Sent! Hash: $TX_HASH"

# --- 4. トランザクションイベント確認 ---
log "🔍 Verifying IBC Packet Emission..."
# ブロックタイム待ち (ポーリングに変更してもいいが単純化のためsleep)
sleep 6 
TX_QUERY=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd q tx $TX_HASH -o json)
PACKET_COUNT=$(echo "$TX_QUERY" | grep "send_packet" | wc -l)

if [ "$PACKET_COUNT" -gt 0 ]; then
    success "Found 'send_packet' events in transaction logs."
else
    error "Transaction committed but NO 'send_packet' event found. Logic error in GWC?"
    # 詳細ログ表示
    echo "$TX_QUERY" | jq .
    exit 1
fi

# --- 5. データ到着の待機 (ポーリング) ---
wait_for_data() {
    local target_pod=$1
    local cmd=$2
    local label=$3
    local jq_filter=$4
    
    log "⏳ Waiting for $label in $target_pod..."
    
    for ((i=1; i<=TIMEOUT_SEC; i+=2)); do
        RES=$(kubectl exec -n "$NAMESPACE" "$target_pod" -- $cmd 2>/dev/null || true)
        COUNT=$(echo "$RES" | jq "$jq_filter" 2>/dev/null || echo "0")
        
        if [ "$COUNT" -gt 0 ]; then
            echo "" # 改行
            success "$label Found! (Time: ${i}s)"
            echo "$RES" | jq .
            return 0
        fi
        
        echo -ne "    ... checking (${i}/${TIMEOUT_SEC}s)\r"
        sleep 2
    done
    echo ""
    error "Timed out waiting for $label."
    return 1
}

# FDSC: Fragmentの確認
wait_for_data "$FDSC_POD" "fdscd q datastore list-fragment -o json" "Fragment" '.fragment | length' || FDSC_FAIL=1

# MDSC: Manifestの確認
wait_for_data "$MDSC_POD" "mdscd q metastore list-manifest -o json" "Manifest" '.manifest | length' || MDSC_FAIL=1

# --- 6. 失敗時の診断 (Commitment Check) ---
if [ -n "$FDSC_FAIL" ] || [ -n "$MDSC_FAIL" ]; then
    echo ""
    log "🩺 Diagnostics: Checking Pending Packets on GWC..."
    
    # 全チャネルのCommitmentをチェック
    CHANNELS=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd q ibc channel channels -o json | jq -r '.channels[].channel_id')
    
    for channel in $CHANNELS; do
        COMMITMENTS=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd q ibc channel packet-commitments gateway "$channel" -o json)
        COUNT=$(echo "$COMMITMENTS" | jq '.commitments | length')
        if [ "$COUNT" -gt 0 ]; then
             error "Pending packets found on $channel (Count: $COUNT). Relayer might be stuck."
        else
             log "No pending packets on $channel."
        fi
    done
    
    error "Test Failed. Data did not arrive."
    exit 1
fi

success "🎉 All checks passed! PoC Upload Flow is working."