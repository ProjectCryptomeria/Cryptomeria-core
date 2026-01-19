#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=/dev/null
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

TEST_NAME="/render の修正（fragment.data参照・timeout/並列制限）が効いているか"
TEST_COMMAND="$(cat <<'CMD'
NS=cryptomeria
PROJECT="render-$(date +%s)"

GWC_POD=$(kubectl -n $NS get pod -l app.kubernetes.io/component=gwc -o jsonpath='{.items[0].metadata.name}')
MDSC_POD=$(kubectl -n $NS get pod -l app.kubernetes.io/component=mdsc -o jsonpath='{.items[0].metadata.name}')

kubectl -n $NS exec "$GWC_POD" -- \
  gwcd tx gateway upload "index.html" "HELLO_RENDER" \
  --project-name "$PROJECT" --version "v1" --fragment-size 1024 \
  --from local-admin --chain-id gwc -y --output json --keyring-backend test --home /home/gwc/.gwc \
  --broadcast-mode sync

until kubectl -n $NS exec "$MDSC_POD" -- mdscd q metastore get-manifest "$PROJECT" -o json >/dev/null 2>&1; do
  echo "waiting manifest..."
  sleep 1
 done

# 期待値: HELLO_RENDER
kubectl -n $NS exec "$GWC_POD" -- curl -s "http://localhost:1317/render?project=$PROJECT&path=index.html"
echo

# 並列アクセスが安定するか (50回、最大20並列)
kubectl -n $NS exec "$GWC_POD" -- sh -c \
  "seq 1 50 | xargs -P 20 -I{} curl -sf 'http://localhost:1317/render?project=$PROJECT&path=index.html' >/dev/null" \
  && echo "OK: parallel render stable"
CMD
)"

case "${1:-}" in
  --name) echo "$TEST_NAME"; exit 0;;
  --command) echo "$TEST_COMMAND"; exit 0;;
esac

require_cmd kubectl

PROJECT="render-$(date +%s)"
GWC_POD="$(gwc_pod)"
MDSC_POD="$(mdsc_pod)"

# Upload sample content
kubectl exec -n "$NAMESPACE" "$GWC_POD" -- \
  gwcd tx gateway upload "index.html" "HELLO_RENDER" \
  --project-name "$PROJECT" --version "v1" --fragment-size 1024 \
  --from local-admin --chain-id gwc -y --output json --keyring-backend test --home /home/gwc/.gwc \
  --broadcast-mode sync

wait_manifest "$PROJECT" 240

# Single render should match
RESULT=$(kubectl exec -n "$NAMESPACE" "$GWC_POD" -- curl -s "http://localhost:1317/render?project=$PROJECT&path=index.html")
echo "$RESULT"
if [ "$RESULT" != "HELLO_RENDER" ]; then
  echo "❌ unexpected render output" >&2
  exit 1
fi

# Parallel render stability check (run inside the pod)
kubectl exec -n "$NAMESPACE" "$GWC_POD" -- sh -c \
  "seq 1 50 | xargs -P 20 -I{} curl -sf 'http://localhost:1317/render?project=$PROJECT&path=index.html' >/dev/null" \
  && echo "OK: parallel render stable"
