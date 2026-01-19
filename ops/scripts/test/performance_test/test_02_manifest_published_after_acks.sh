#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=/dev/null
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

TEST_NAME="Manifestは“全Fragment ACK後”に公開されるか"
TEST_COMMAND="$(cat <<'CMD'
NS=cryptomeria
PROJECT="ackgate-$(date +%s)"

GWC_POD=$(kubectl -n $NS get pod -l app.kubernetes.io/component=gwc -o jsonpath='{.items[0].metadata.name}')
RELAYER_POD=$(kubectl -n $NS get pod -l app.kubernetes.io/component=relayer -o jsonpath='{.items[0].metadata.name}')
MDSC_POD=$(kubectl -n $NS get pod -l app.kubernetes.io/component=mdsc -o jsonpath='{.items[0].metadata.name}')

kubectl -n $NS exec "$RELAYER_POD" -- sh -c "pkill -x rly || true"

kubectl -n $NS exec "$GWC_POD" -- \
  gwcd tx gateway upload "index.html" "HELLO_ACK_GATE" \
  --project-name "$PROJECT" --version "v1" \
  --from local-admin --chain-id gwc -y --output json --keyring-backend test --home /home/gwc/.gwc \
  --broadcast-mode sync

kubectl -n $NS exec "$MDSC_POD" -- mdscd q metastore get-manifest "$PROJECT" -o json || echo "OK: manifest not published yet"

# relayer restart
./ops/scripts/control/start-relayer.sh

until kubectl -n $NS exec "$MDSC_POD" -- mdscd q metastore get-manifest "$PROJECT" -o json >/dev/null 2>&1; do
  echo "waiting manifest..."
  sleep 1
done
echo "OK: manifest published after ACKs"
CMD
)"

case "${1:-}" in
  --name) echo "$TEST_NAME"; exit 0;;
  --command) echo "$TEST_COMMAND"; exit 0;;
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
