#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=/dev/null
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

TEST_NAME="エンドポイント確認"

case "${1:-}" in
  --name) echo "$TEST_NAME"; exit 0;;
esac

require_cmd kubectl jq

GWC_POD="$(gwc_pod)"
kubectl exec -n "$NAMESPACE" "$GWC_POD" -- gwcd q gateway endpoints -o json | jq .
