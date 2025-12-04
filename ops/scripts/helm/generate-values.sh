#!/bin/bash
set -euo pipefail

# --- 引数のチェック ---
if [ -z "$1" ]; then
    echo "💥 Error: Missing argument." >&2
    echo "Usage: $0 <fdsc-count>" >&2
    exit 1
fi

FDSC_COUNT=$1

# --- YAMLの生成 ---
echo "chains:"

# 1. GWC (Gateway Chain) - 常に1台
echo "  - name: gwc"
echo "    type: gwc"

# 2. MDSC (Metastore Chain) - 常に1台
echo "  - name: mdsc"
echo "    type: mdsc"

# 3. FDSC (Datastore Chain) - 指定された台数
for i in $(seq 0 $(($FDSC_COUNT - 1))); do
  echo "  - name: fdsc-$i"
  echo "    type: fdsc"
done