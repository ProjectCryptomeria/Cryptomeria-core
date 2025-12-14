#!/bin/bash
set -e
source "$(dirname "$0")/lib/common.sh"

echo "=== Phase 4-4: Distributed Storage (Sharding) Test ==="

# 1. FDSCノードを増やす (Common Libではなく親ディレクトリのスクリプトを使用)
SCALE_SCRIPT="$(dirname "$0")/../../control/scale-fdsc.sh"
TARGET_NODES=2

log_step "📈 Scaling FDSC to $TARGET_NODES nodes..."
"$SCALE_SCRIPT" "$TARGET_NODES"

# 2. 各ノードへ分散アップロード
# fdsc-0 と fdsc-1 にそれぞれ別ファイルをアップロードする
NODES=("fdsc-0" "fdsc-1")

for NODE in "${NODES[@]}"; do
    FILENAME="data-for-$NODE.txt"
    LOCAL_PATH="/tmp/$FILENAME"
    REMOTE_PATH="/tmp/$FILENAME"
    
    # ファイル作成
    echo "This data belongs to $NODE at $(date)" > "$LOCAL_PATH"
    
    # GWC転送 & アップロード (ターゲットチェーンを明示的に指定)
    push_to_gwc "$LOCAL_PATH" "$REMOTE_PATH"
    upload_and_wait "$REMOTE_PATH" "$NODE"
    
    # 検証: 指定したノードにデータがあるか
    # verify_data関数は内部で `get_chain_pod_name $NODE` を呼ぶので、
    # 正しく fdsc-0 または fdsc-1 のPodにクエリを投げて検証してくれる
    verify_data "$NODE" "$LOCAL_PATH"
    
    # 逆検証: 別のノードには（最新の）データがない、あるいは異なることを確認すべきだが、
    # 今回は「指定先に正しく保存されたか」を主眼とする。
done

# クリーンアップ (ノード数を戻す)
log_step "📉 Scaling down FDSC to 1 node..."
"$SCALE_SCRIPT" 1

log_success "Test 04 (Distributed Storage) Passed!"