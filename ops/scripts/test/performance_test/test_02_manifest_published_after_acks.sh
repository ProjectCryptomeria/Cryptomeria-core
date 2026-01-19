#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=/dev/null
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

TEST_NAME="Manifestは“全Fragment ACK後”に公開されるか"

case "${1:-}" in
  --name) echo "$TEST_NAME"; exit 0;;
esac

require_cmd kubectl

PROJECT="ackgate-$(date +%s)"
GWC_POD="$(gwc_pod)"
MDSC_POD="$(mdsc_pod)"

# Stop relayer to ensure ACK is delayed
stop_relayer

# Upload (wait commit)
kubectl exec -n "$NAMESPACE" "$GWC_POD" -- \
  gwcd tx gateway upload "index.html" "HELLO_ACK_GATE" \
  --project-name "$PROJECT" --version "v1" \
  --from local-admin --chain-id gwc -y --output json --keyring-backend test --home /home/gwc/.gwc \
  --broadcast-mode sync

# Before starting relayer, manifest should not exist
if kubectl exec -n "$NAMESPACE" "$MDSC_POD" -- mdscd q metastore get-manifest "$PROJECT" -o json; then
  echo "❌ manifest unexpectedly published before ACKs" >&2
  exit 1
else
  echo "OK: manifest not published yet"
fi

# Restart relayer (robust background startup)
start_relayer

# Wait for manifest to become available
wait_manifest "$PROJECT" 240

echo "OK: manifest published after ACKs"
