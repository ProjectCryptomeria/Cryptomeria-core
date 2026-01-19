#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

cd "$ROOT_DIR"

TEST_DIR="$ROOT_DIR/ops/scripts/test/performance_test"

usage() {
  cat <<USAGE
Usage:
  $0                Run all performance test scripts and print formatted results
  $0 --list         List available test scripts
  $0 --only <glob>  Run only scripts matching a glob (e.g. 'test_03*')

Environment:
  NAMESPACE (default: cryptomeria)
USAGE
}

ONLY_GLOB=""

case "${1:-}" in
  --help|-h)
    usage
    exit 0
    ;;
  --list)
    ls -1 "$TEST_DIR"/test_*.sh | sed 's#.*/##' | sort
    exit 0
    ;;
  --only)
    ONLY_GLOB="${2:-}"
    if [ -z "$ONLY_GLOB" ]; then
      echo "❌ --only requires a glob" >&2
      exit 2
    fi
    ;;
  "")
    ;;
  *)
    echo "❌ Unknown argument: $1" >&2
    usage
    exit 2
    ;;
esac

mapfile -t SCRIPTS < <(ls -1 "$TEST_DIR"/test_*.sh 2>/dev/null | sort)

if [ "${#SCRIPTS[@]}" -eq 0 ]; then
  echo "❌ No test scripts found in $TEST_DIR" >&2
  exit 1
fi

if [ -n "$ONLY_GLOB" ]; then
  mapfile -t SCRIPTS < <(ls -1 "$TEST_DIR"/$ONLY_GLOB 2>/dev/null | sort || true)
  if [ "${#SCRIPTS[@]}" -eq 0 ]; then
    echo "❌ No scripts match glob: $ONLY_GLOB" >&2
    exit 1
  fi
fi

FAILURES=0

for script in "${SCRIPTS[@]}"; do
  if [ ! -x "$script" ]; then
    chmod +x "$script" || true
  fi

  NAME="$("$script" --name)"
  COMMAND="$("$script" --command)"

  echo "テスト名："
  echo "$NAME"
  echo "コマンド："
  echo "$COMMAND"
  echo "出力："

  set +e
  OUTPUT="$($script 2>&1)"
  RC=$?
  set -e

  echo "$OUTPUT"
  if [ $RC -ne 0 ]; then
    echo "(exit code $RC)"
    FAILURES=$((FAILURES + 1))
  fi

  echo
done

if [ $FAILURES -ne 0 ]; then
  exit 1
fi
