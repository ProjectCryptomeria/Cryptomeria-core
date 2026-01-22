# API第三層仕様書（Utilities / Experiment Layer）

- 対象: Cryptomeria-BFF v1
- 版: 1.0.0
- 最終更新: 2026-01-23
- Base Path: `/api/v1/utils`
- この層の目的:
  - 実験・観測・データ取得・負荷試験など「便利機能」を提供する
  - 長時間/高負荷になり得る処理は **非同期ジョブ化**し、実験の再現性・運用性を上げる
  - TPS/throughput は **ブロックヘッダ時刻ベース**で統一定義し、比較可能性を担保する

> 第3層のジョブモデルは **APIJOB仕様書.md** に準拠する。  
> 本仕様書では Utilities スコープの job type / step / リクエスト仕様を規定する。

---

## 1. 共通仕様

### 1.1 Content-Type
- Request/Response は基本 `application/json; charset=utf-8`

### 1.2 エラー形式（共通）
```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "timeoutMs must be >= 1000",
    "details": { "field": "timeoutMs" }
  }
}
```

代表 code:
- `INVALID_ARGUMENT` (400)
- `NOT_FOUND` (404)
- `CONFLICT` (409) : 排他
- `RATE_LIMITED` (429) : 並列/レート制限
- `UPSTREAM_UNAVAILABLE` (503)
- `UPSTREAM_ERROR` (502)
- `INTERNAL` (500)

### 1.3 並列上限（サーバ側強制）
- Utilities 層は負荷をかけるAPIを含むため、サーバ側で必ず上限を持つ。
- 代表:
  - `maxConcurrency`（broadcast等）: default 20（環境変数で変更可）
  - `maxBatchSize`（txs等）: default 1000（環境変数で変更可）
- 上限超過時は 400（サイズ）または 429（並列）を返す。

---

## 2. エンドポイント一覧

### 2.1 Utilities ジョブ（Utilsスコープ）
- `GET /jobs`
- `GET /jobs/{jobId}`
- `GET /jobs/{jobId}/logs`
- `POST /jobs/{jobId}/cancel`

> System層の `/api/v1/system/jobs/*` と同一モデル。  
> 共通仕様は APIJOB仕様書.md に従う。

### 2.2 観測・統計（ジョブ）
- `POST /observe/tx-confirmation`（txが確定するまで待機）
- `POST /observe/tx-confirmation-batch`（複数txhashの確定待ち）
- `POST /metrics/throughput`（TPS/throughput近似）
- `POST /metrics/resource-snapshot`（k8s+chainのスナップショット）

### 2.3 負荷（ジョブ）
- `POST /load/broadcast-batch`（署名済みTxを並列broadcast）
- `POST /load/broadcast-and-confirm`（broadcastし、確定まで追跡）

---

## 3. ジョブ永続化
- v1では **インメモリのみ**。BFF再起動でジョブは消える。
- 冪等性:
  - Utilities は「計測/負荷」の性質上、原則として冪等判定は限定的。
  - ただし `resource-snapshot` は “現在の状態を取るだけ” なので、force=falseでも冪等性問題は小さい。
  - batch観測/負荷は “再実行＝別実験” とみなしやすいため、冪等skipは基本しない（必要なら `requestId` で重複排除を将来拡張）。

---

## 4. データモデル（第3層）

### 4.1 TxConfirmationResult
```json
{
  "chainId": "gwc",
  "txhash": "ABCDEF...",
  "confirmed": true,
  "height": 12345,
  "firstSeenAt": "2026-01-23T09:00:00Z",
  "confirmedAt": "2026-01-23T09:00:05Z",
  "latencyMs": 5000
}
```

### 4.2 BatchSummary
```json
{
  "total": 100,
  "succeeded": 95,
  "failed": 5,
  "durationMs": 12000
}
```

### 4.3 ThroughputResult（固定定義）
```json
{
  "chainId": "gwc",
  "range": { "startHeight": 12246, "endHeight": 12345 },
  "timeStart": "2026-01-23T08:58:20Z",
  "timeEnd": "2026-01-23T09:00:00Z",
  "durationSeconds": 100,
  "totalTx": 1200,
  "tps": 12.0,
  "computedAt": "2026-01-23T09:00:01Z"
}
```

### 4.4 ResourceSnapshotResult
```json
{
  "observedAt": "2026-01-23T09:00:00Z",
  "namespace": "cryptomeria",
  "systemStatus": { "...": "see /system/status" },
  "notes": ["snapshot is best-effort"]
}
```

---

# 5. 観測ジョブ

## 5.1 POST /observe/tx-confirmation
txhash が確定（Tx検索で取得可能）するまで待機する。

### Request
```json
{
  "chainId": "gwc",
  "txhash": "ABCDEF...",
  "timeoutMs": 300000,
  "pollIntervalMs": 1000
}
```

制約:
- `timeoutMs`: 1,000以上
- `pollIntervalMs`: 200以上（推奨 500〜2000）

### Response
- 202: Job作成（type=`utils.observe.tx-confirmation`）

### Job Result（成功時）
```json
{
  "result": {
    "chainId": "gwc",
    "txhash": "ABCDEF...",
    "confirmed": true,
    "height": 12345,
    "firstSeenAt": "2026-01-23T09:00:00Z",
    "confirmedAt": "2026-01-23T09:00:05Z",
    "latencyMs": 5000
  }
}
```

### steps（推奨）
1. `validate`
2. `pollTx`
3. `finish`

---

## 5.2 POST /observe/tx-confirmation-batch
複数 txhash の確定を待機し、統計を返す。

### Request
```json
{
  "chainId": "gwc",
  "txhashes": ["A...", "B...", "C..."],
  "timeoutMs": 300000,
  "pollIntervalMs": 1000,
  "maxConcurrency": 20,
  "stopOnFirstError": false
}
```

制約:
- `txhashes.length` <= `maxBatchSize`（default 1000）
- `maxConcurrency` <= `maxConcurrencyLimit`（default 20）

### Response
- 202: Job作成（type=`utils.observe.tx-confirmation-batch`）

### Job Result（成功時）
```json
{
  "result": {
    "summary": { "total": 3, "succeeded": 3, "failed": 0, "durationMs": 12000 },
    "items": [
      { "txhash": "A...", "confirmed": true, "latencyMs": 5000, "height": 12345 },
      { "txhash": "B...", "confirmed": true, "latencyMs": 7000, "height": 12346 }
    ]
  }
}
```

### steps（推奨）
1. `validate`
2. `pollBatch`
3. `aggregate`
4. `finish`

---

# 6. メトリクス（TPS / throughput）ジョブ

## 6.1 POST /metrics/throughput
指定 window の範囲で TPS/throughput 近似を算出する。

### 固定定義（必ずこの方式）
- `endHeight = latestHeight`
- `startHeight = endHeight - window + 1`
- `totalTx = Σ txCount[h] for h in [startHeight..endHeight]`
- `durationSeconds = (headerTime[endHeight] - headerTime[startHeight]).seconds`
- `tps = totalTx / durationSeconds`
- 返却に `startHeight/endHeight/timeStart/timeEnd/totalTx/durationSeconds` を必ず含める

> ブロックヘッダ時刻ベース。wall-clockを使わない。

### Request
```json
{
  "chainId": "gwc",
  "window": 100,
  "mode": "auto",
  "timeoutMs": 120000
}
```

制約:
- `window`: min=2, max=2000

### Response
- 202: Job作成（type=`utils.metrics.throughput`）

### Job Result（成功時）
```json
{
  "result": {
    "chainId": "gwc",
    "range": { "startHeight": 12246, "endHeight": 12345 },
    "timeStart": "2026-01-23T08:58:20Z",
    "timeEnd": "2026-01-23T09:00:00Z",
    "durationSeconds": 100,
    "totalTx": 1200,
    "tps": 12.0,
    "computedAt": "2026-01-23T09:00:01Z"
  }
}
```

### steps（推奨）
1. `validate`
2. `resolveHeights`
3. `fetchBlocks`
4. `compute`
5. `finish`

---

# 7. リソーススナップショット（実験ログ用）ジョブ

## 7.1 POST /metrics/resource-snapshot
k8s+chain の状態をまとめて採取し、実験ログに添付しやすい形で返す。

### Request
```json
{
  "namespace": "cryptomeria",
  "include": ["systemStatus", "pods", "services", "chainsStatus"],
  "timeoutMs": 60000
}
```

- `include`（optional）:
  - `systemStatus`: `/system/status` 相当
  - `pods`: `/system/k8s/pods` 相当
  - `services`: `/system/k8s/services` 相当
  - `chainsStatus`: `/chains/{chainId}/status` を全チェーン分

### Response
- 202: Job作成（type=`utils.metrics.resource-snapshot`）

### Job Result（成功時）
```json
{
  "result": {
    "observedAt": "2026-01-23T09:00:00Z",
    "namespace": "cryptomeria",
    "systemStatus": { "...": "..." },
    "pods": { "items": [ "..." ] },
    "services": { "items": [ "..." ] },
    "chainsStatus": [
      { "chainId": "gwc", "latestHeight": 12345, "catchingUp": false }
    ]
  }
}
```

### steps（推奨）
1. `validate`
2. `collectSystem`
3. `collectChains`
4. `finish`

---

# 8. 負荷ジョブ

## 8.1 POST /load/broadcast-batch
署名済みTxを並列 broadcast し、成功率とエラー分類を返す。

### Request
```json
{
  "chainId": "gwc",
  "txBytesBase64List": ["....", "...."],
  "broadcastMode": "sync",
  "maxConcurrency": 20,
  "timeoutMs": 300000,
  "stopOnFirstError": false
}
```

制約:
- `txBytesBase64List.length` <= `maxBatchSize`（default 1000）
- `maxConcurrency` <= `maxConcurrencyLimit`（default 20）

### Response
- 202: Job作成（type=`utils.load.broadcast-batch`）

### Job Result（成功時）
```json
{
  "result": {
    "summary": { "total": 2, "succeeded": 2, "failed": 0, "durationMs": 1200 },
    "items": [
      { "index": 0, "txhash": "A...", "ok": true },
      { "index": 1, "txhash": "B...", "ok": true }
    ]
  }
}
```

### steps（推奨）
1. `validate`
2. `broadcastBatch`
3. `aggregate`
4. `finish`

---

## 8.2 POST /load/broadcast-and-confirm
署名済みTxを broadcast し、確定まで追跡する（負荷＋観測の統合）。

### Request
```json
{
  "chainId": "gwc",
  "txBytesBase64List": ["....", "...."],
  "broadcastMode": "sync",
  "maxConcurrency": 10,
  "timeoutMs": 600000,
  "pollIntervalMs": 1000
}
```

### Response
- 202: Job作成（type=`utils.load.broadcast-and-confirm`）

### Job Result（成功時）
```json
{
  "result": {
    "summary": { "total": 2, "succeeded": 2, "failed": 0, "durationMs": 20000 },
    "items": [
      { "index": 0, "txhash": "A...", "confirmed": true, "latencyMs": 8000 },
      { "index": 1, "txhash": "B...", "confirmed": true, "latencyMs": 9000 }
    ]
  }
}
```

### steps（推奨）
1. `validate`
2. `broadcastBatch`
3. `confirmBatch`
4. `aggregate`
5. `finish`

---

# 9. Utilitiesジョブ type と step 定義（APIJOB仕様書への上書き）

## 9.1 job type 一覧
- `utils.observe.tx-confirmation`
- `utils.observe.tx-confirmation-batch`
- `utils.metrics.throughput`
- `utils.metrics.resource-snapshot`
- `utils.load.broadcast-batch`
- `utils.load.broadcast-and-confirm`

## 9.2 排他・同時実行
- v1では Utilities ジョブは複数同時実行を許容するが、
  - サーバ側の `maxRunningJobs`（例: 4）を超える場合は 429 を返す
  - `utils.load.*` は system に影響が大きいので、同時に走らせる上限を別途持つ（例: 1〜2）

---

# 10. 非対応（v1スコープ外）
- 署名生成（第2層同様）
- “永続ログ” の保存（ジョブログはインメモリ/揮発）
- WebSocketによるリアルタイム配信

---

# 11. 変更履歴
- 1.0.0: v1 初版（Utilitiesを全面ジョブ化、throughput定義を固定）
