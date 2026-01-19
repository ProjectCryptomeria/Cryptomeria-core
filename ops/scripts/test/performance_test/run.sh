#!/usr/bin/env bash
set -euo pipefail

# スクリプトのディレクトリ設定
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

cd "$ROOT_DIR"

TEST_DIR="$ROOT_DIR/ops/scripts/test/performance_test"

# ヘルプ表示
usage() {
  cat <<USAGE
Usage:
  $0                すべてのパフォーマンステストを順次実行します
  $0 -i, --interactive  対話モード（複数選択可）で実行します
  $0 --list         利用可能なテストスクリプトを一覧表示します
  $0 --only <glob>  globパターンに一致するスクリプトのみを実行します (例: 'test_03*')

Environment:
  NAMESPACE (default: cryptomeria)
USAGE
}

INTERACTIVE=false
ONLY_GLOB=""

# 引数解析
while [[ $# -gt 0 ]]; do
  case "${1:-}" in
    --help|-h)
      usage
      exit 0
      ;;
    --list)
      ls -1 "$TEST_DIR"/test_*.sh | sed 's#.*/##' | sort
      exit 0
      ;;
    --interactive|-i)
      INTERACTIVE=true
      shift
      ;;
    --only)
      ONLY_GLOB="${2:-}"
      if [ -z "$ONLY_GLOB" ]; then
        echo "❌ --only requires a glob" >&2
        exit 2
      fi
      shift 2
      ;;
    *)
      echo "❌ Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

# テストスクリプトのリスト取得
mapfile -t ALL_SCRIPTS < <(ls -1 "$TEST_DIR"/test_*.sh 2>/dev/null | sort)

if [ "${#ALL_SCRIPTS[@]}" -eq 0 ]; then
  echo "❌ No test scripts found in $TEST_DIR" >&2
  exit 1
fi

# 実行対象スクリプトの配列
TARGET_SCRIPTS=()

# --- 実行モードの分岐 ---

if [ "$INTERACTIVE" = true ]; then
  echo "📋 利用可能なテストスクリプト:"
  echo "   [a] All (すべて実行)"
  
  # リスト表示（ファイル名 + 日本語名）
  i=1
  for s in "${ALL_SCRIPTS[@]}"; do
    filename=$(basename "$s")
    # スクリプトから日本語名を取得（エラー時はスキップ）
    test_name=$("$s" --name 2>/dev/null || echo "")
    
    if [ -n "$test_name" ]; then
      printf "   [%d] %s  (%s)\n" "$i" "$filename" "$test_name"
    else
      printf "   [%d] %s\n" "$i" "$filename"
    fi
    ((i++))
  done
  echo

  # 入力受付
  read -r -p "実行したい番号を入力してください (スペース区切り, 例: '2 5', 'a'で全選択): " input_str

  # 入力解析
  for item in $input_str; do
    if [[ "$item" == "a" || "$item" == "all" ]]; then
      TARGET_SCRIPTS=("${ALL_SCRIPTS[@]}")
      break
    elif [[ "$item" =~ ^[0-9]+$ ]]; then
      # 1始まりの番号を0始まりのインデックスに変換
      idx=$((item - 1))
      if [ -n "${ALL_SCRIPTS[$idx]:-}" ]; then
        TARGET_SCRIPTS+=("${ALL_SCRIPTS[$idx]}")
      else
        echo "⚠️  番号 [$item] は無効なため無視されます"
      fi
    fi
  done

  if [ "${#TARGET_SCRIPTS[@]}" -eq 0 ]; then
    echo "❌ 実行対象が選択されませんでした。"
    exit 1
  fi

elif [ -n "$ONLY_GLOB" ]; then
  # glob指定がある場合
  mapfile -t TARGET_SCRIPTS < <(ls -1 "$TEST_DIR"/$ONLY_GLOB 2>/dev/null | sort || true)
  if [ "${#TARGET_SCRIPTS[@]}" -eq 0 ]; then
    echo "❌ No scripts match glob: $ONLY_GLOB" >&2
    exit 1
  fi
else
  # デフォルト: すべて実行
  TARGET_SCRIPTS=("${ALL_SCRIPTS[@]}")
fi

# --- テスト実行ループ ---

FAILURES=0
echo
echo "🚀 Starting Performance Test Suite..."
echo "=================================================="

for script in "${TARGET_SCRIPTS[@]}"; do
  if [ ! -x "$script" ]; then
    chmod +x "$script" || true
  fi

  # テスト名を取得
  NAME="$("$script" --name)"
  
  echo "🧪 テスト名： $NAME"
  echo "📄 実行スクリプト全文:"
  echo "--------------------------------------------------"
  # スクリプトの内容を全文表示
  cat "$script"
  echo "--------------------------------------------------"
  echo "▶️  実行結果："

  set +e
  # スクリプト実行 (標準エラー出力も統合してキャプチャ)
  OUTPUT="$($script 2>&1)"
  RC=$?
  set -e

  echo "$OUTPUT"
  
  if [ $RC -ne 0 ]; then
    echo "❌ FAILED (exit code $RC)"
    FAILURES=$((FAILURES + 1))
  else
    echo "✅ PASSED"
  fi

  echo "=================================================="
done

if [ $FAILURES -ne 0 ]; then
  echo "💀 Total Failures: $FAILURES"
  exit 1
else
  echo "🎉 All tests passed successfully!"
  exit 0
fi