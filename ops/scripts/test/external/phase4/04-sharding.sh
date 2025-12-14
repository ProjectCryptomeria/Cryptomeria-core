#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

echo "=== Phase 4-4: Distributed Storage (Sharding) Test ==="


log_step "📈 Scaling FDSC to $TARGET_NODES nodes..."
"$SCALE_SCRIPT" "$TARGET_NODES"

# 2. 各ノードへ分散アップロード
NODES=("fdsc-0" "fdsc-1")
PROJECT_PREFIX="shard-test-$(date +%s)"
FRAGMENT_SIZE=10240 # 10KB

for NODE in "${NODES[@]}"; do
    FILENAME="data-for-$NODE.txt"
    LOCAL_PATH="/tmp/$FILENAME"
    REMOTE_PATH="/tmp/$FILENAME"
    PROJECT_NAME="${PROJECT_PREFIX}-${NODE}"
    
    echo "This data belongs to $NODE at $(date)" > "$LOCAL_PATH"
    
    push_to_gwc "$LOCAL_PATH" "$REMOTE_PATH"
    upload_and_wait_v2 "$REMOTE_PATH" "$NODE" "$PROJECT_NAME" "1.0" "$FRAGMENT_SIZE"
    
    # 検証
    verify_data "$NODE" "$LOCAL_PATH" "$FILENAME" "$PROJECT_NAME"
done

log_step "📉 Scaling down FDSC to 1 node..."
"$SCALE_SCRIPT" 1

log_success "Test 04 (Distributed Storage) Passed!"