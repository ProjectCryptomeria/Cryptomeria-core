#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=/dev/null
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

TEST_NAME="Fragment ID決定的テスト"

case "${1:-}" in
  --name) echo "$TEST_NAME"; exit 0;;
esac

require_cmd kubectl jq diff tee

PROJECT="detid-$(date +%s)"
GWC_POD="$(gwc_pod)"
MDSC_POD="$(mdsc_pod)"

# 1st upload
kubectl exec -n "$NAMESPACE" "$GWC_POD" -- \
  gwcd tx gateway upload "index.html" "SAME_CONTENT" \
  --project-name "$PROJECT" --version "v1" --fragment-size 1024 \
  --from local-admin --chain-id gwc -y --output json --keyring-backend test --home /home/gwc/.gwc \
  --broadcast-mode sync

wait_manifest "$PROJECT" 240

tmp1="$(mktemp)"
tmp2="$(mktemp)"

kubectl exec -n "$NAMESPACE" "$MDSC_POD" -- mdscd q metastore get-manifest "$PROJECT" -o json \
  | jq -r '.files["index.html"].fragments[].fragment_id' | tee "$tmp1"

# 2nd upload (same content & size)
kubectl exec -n "$NAMESPACE" "$GWC_POD" -- \
  gwcd tx gateway upload "index.html" "SAME_CONTENT" \
  --project-name "$PROJECT" --version "v1" --fragment-size 1024 \
  --from local-admin --chain-id gwc -y --output json --keyring-backend test --home /home/gwc/.gwc \
  --broadcast-mode sync

# Give time for ACK and possible manifest update
wait_manifest "$PROJECT" 240

kubectl exec -n "$NAMESPACE" "$MDSC_POD" -- mdscd q metastore get-manifest "$PROJECT" -o json \
  | jq -r '.files["index.html"].fragments[].fragment_id' | tee "$tmp2"

if diff -u "$tmp1" "$tmp2"; then
  echo "OK: deterministic fragment IDs"
else
  echo "❌ fragment IDs changed (not deterministic)" >&2
  exit 1
fi
