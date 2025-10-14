#!/bin/bash
set -euo pipefail

# --- 引数のチェック ---
if [ -z "$1" ]; then
    echo "💥 Error: Missing argument." >&2
    echo "Usage: $0 <datachain-count>" >&2
    exit 1
fi

DATACHAIN_COUNT=$1

# --- YAMLの生成 ---

# datachainのリストを生成
echo "chains:"
for i in $(seq 0 $(($DATACHAIN_COUNT - 1))); do
  echo "  - name: data-$i"
  echo "    type: datachain"
done

# metachainをリストの末尾に必ず追加
echo "  - name: meta-0"
echo "    type: metachain"