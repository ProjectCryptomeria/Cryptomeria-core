#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=/dev/null
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

TEST_NAME="同一fragment_idでデータが違う場合、FDSCが拒否できるかテスト"
TEST_COMMAND="$(cat <<'CMD'
NS=cryptomeria
PROJECT="conflict-$(date +%s)"

GWC_POD=$(kubectl -n $NS get pod -l app.kubernetes.io/component=gwc -o jsonpath='{.items[0].metadata.name}')
MDSC_POD=$(kubectl -n $NS get pod -l app.kubernetes.io/component=mdsc -o jsonpath='{.items[0].metadata.name}')

# 1回目
kubectl -n $NS exec "$GWC_POD" -- \
  gwcd tx gateway upload "index.html" "CONFLICT_TEST_PAYLOAD_ABCDEFGHIJKLMNOPQRSTUVWXYZ" \
  --project-name "$PROJECT" --version "v1" --fragment-size 1024 \
  --from local-admin --chain-id gwc -y --output json \
  --broadcast-mode block \
  --keyring-backend test --home /home/gwc/.gwc

until kubectl -n $NS exec "$MDSC_POD" -- mdscd q metastore get-manifest "$PROJECT" -o json >/dev/null 2>&1; do
  echo "waiting manifest..."
  sleep 1
 done

# fragment_id(先頭)を記録
FRAG_ID=$(kubectl -n $NS exec "$MDSC_POD" -- mdscd q metastore get-manifest "$PROJECT" -o json | jq -r '.files["index.html"].fragments[0].fragment_id')

# 2回目: fragment-size を変えて同一 fragment_id で異なるデータを作る
kubectl -n $NS exec "$GWC_POD" -- \
  gwcd tx gateway upload "index.html" "CONFLICT_TEST_PAYLOAD_ABCDEFGHIJKLMNOPQRSTUVWXYZ" \
  --project-name "$PROJECT" --version "v1" --fragment-size 2048 \
  --from local-admin --chain-id gwc -y --output json \
  --broadcast-mode block \
  --keyring-backend test --home /home/gwc/.gwc

# 直近ログから拒否を確認 (環境によりメッセージが異なるため広めにgrep)
kubectl -n $NS logs -l app.kubernetes.io/component=fdsc --since=5m | grep -i "index already set\|conflict\|already exists" || true
kubectl -n $NS logs -l app.kubernetes.io/component=relayer --since=5m | grep -i "$FRAG_ID\|index already set\|conflict\|error\|acknowledgement" || true
CMD
)"

case "${1:-}" in
  --name) echo "$TEST_NAME"; exit 0;;
  --command) echo "$TEST_COMMAND"; exit 0;;
esac

require_cmd kubectl jq

PROJECT="conflict-$(date +%s)"
GWC_POD="$(gwc_pod)"
MDSC_POD="$(mdsc_pod)"

# 1st upload
kubectl exec -n "$NAMESPACE" "$GWC_POD" -- \
  gwcd tx gateway upload "index.html" "CONFLICT_TEST_PAYLOAD_ABCDEFGHIJKLMNOPQRSTUVWXYZ" \
  --project-name "$PROJECT" --version "v1" --fragment-size 1024 \
  --from local-admin --chain-id gwc -y --output json \
  --broadcast-mode sync \
  --keyring-backend test --home /home/gwc/.gwc

wait_manifest "$PROJECT" 240

# Capture first fragment id for log correlation
FRAG_ID="$(kubectl exec -n "$NAMESPACE" "$MDSC_POD" -- mdscd q metastore get-manifest "$PROJECT" -o json | jq -r '.files["index.html"].fragments[0].fragment_id')"
echo "fragment_id[0]=$FRAG_ID"

# 2nd upload with different fragment-size (should cause same fragment_id with different bytes in at least one fragment)
kubectl exec -n "$NAMESPACE" "$GWC_POD" -- \
  gwcd tx gateway upload "index.html" "CONFLICT_TEST_PAYLOAD_ABCDEFGHIJKLMNOPQRSTUVWXYZ" \
  --project-name "$PROJECT" --version "v1" --fragment-size 2048 \
  --from local-admin --chain-id gwc -y --output json \
  --broadcast-mode sync \
  --keyring-backend test --home /home/gwc/.gwc

# Wait a bit for packets/acks/logs to show up
sleep 10

# Detect rejection from recent logs
FD_LOGS=$(kubectl logs -n "$NAMESPACE" -l app.kubernetes.io/component=fdsc --max-log-requests=10 --since=10m 2>/dev/null | tail -n 400 || true)
RL_LOGS=$(kubectl logs -n "$NAMESPACE" -l app.kubernetes.io/component=relayer --max-log-requests=10 --since=10m 2>/dev/null | tail -n 600 || true)

echo "--- fdsc logs (tail) ---"
echo "$FD_LOGS" | grep -i -E "index already set|conflict|already exists|unauthorized|invalid request" || true

echo "--- relayer logs (tail) ---"
echo "$RL_LOGS" | grep -i -E "${FRAG_ID}|index already set|conflict|error assembling|acknowled" || true

if echo "$FD_LOGS$RL_LOGS" | grep -i -E "index already set|conflict|already exists" >/dev/null 2>&1; then
  echo "OK: rejection signal detected in logs"
else
  echo "❌ could not find rejection signal in logs (check logs manually)" >&2
  exit 1
fi
