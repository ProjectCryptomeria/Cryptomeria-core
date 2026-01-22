# API第二層仕様書（Blockchain Layer）

- 対象: Cryptomeria-BFF v1
- 版: 1.0.0
- 最終更新: 2026-01-23
- Base Path: `/api/v1/chains`
- この層の目的:
  - チェーン内部のブロックチェーン処理（照会、Tx送信、観測）を HTTP API として提供する
  - チェーン一覧は **Pod 起点**で列挙する（実在するチェーンを返す）
  - ブロック時間計測や tx/blocks 取得など、卒研実験に必要な観測機能を提供する
  - k8s の Service/Port 詳細は第1層（System/K8s）に委譲し、ここでは「必要な場合のみ endpoint 解決」を行う

---

## 1. 前提・制約

### 1.1 チェーン一覧の起点
- `/chains` は **Pod 起点**で chainId を列挙する。
- chainId は原則として `app.kubernetes.io/instance`（または同等の label）から取得する。
- “Pod が存在しない chainId” は返さない（＝実体のあるチェーンのみ）。

### 1.2 endpoint 解決（必要時のみ）
- エンドポイント（RPC/RESTなど）の解決は以下のいずれかで行う:
  1) BFFの環境変数（固定 endpoint）
  2) K8s Service/Endpoints の discovery（NodePort/ClusterIP 等）
- `/chains` 自体は endpoint を必須にしない。  
  `include=endpoints` が指定された場合のみ解決を試みる。

### 1.3 mode
- `mode=external|internal|auto` をサポートする（v1）。
  - `external`: NodePort 等、クラスタ外から到達可能な endpoint を優先
  - `internal`: ClusterIP / PodDNS 等、クラスタ内到達を想定（BFFが外部の場合でも定義は残す）
  - `auto`: 利用可能なものを優先順で選択

---

## 2. 共通仕様

### 2.1 Content-Type
- Request/Response は基本 `application/json; charset=utf-8`

### 2.2 時刻
- すべて ISO 8601（UTC推奨）例: `2026-01-23T09:00:00Z`

### 2.3 エラー形式（共通）
```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "chainId is unknown",
    "details": { "chainId": "gwc" }
  }
}
```

代表 code:
- `INVALID_ARGUMENT` (400)
- `NOT_FOUND` (404)
- `UPSTREAM_UNAVAILABLE` (503) : RPC/REST 到達不可
- `UPSTREAM_ERROR` (502) : 上流がエラー
- `INTERNAL` (500)

---

## 3. データモデル（第2層）

### 3.1 ChainSummary
```json
{
  "chainId": "gwc",
  "pod": { "name": "cryptomeria-gwc-0", "ready": true },
  "endpoints": {
    "rpc": "http://<host>:30001",
    "rest": "http://<host>:30002"
  }
}
```
- `endpoints` は `include=endpoints` の時のみ付与される（解決できない場合は省略可）。

### 3.2 TxBroadcastResult
```json
{
  "txhash": "ABCDEF...",
  "height": 123,
  "code": 0,
  "rawLog": "...",
  "gasWanted": "200000",
  "gasUsed": "180000"
}
```

### 3.3 BlockSummary
```json
{
  "height": 12345,
  "hash": "....",
  "time": "2026-01-23T09:00:00Z",
  "txCount": 12
}
```

---

## 4. エンドポイント一覧

### 4.1 チェーンディスカバリ
- `GET /`（チェーン一覧）
- `GET /{chainId}/info`（基本情報）
- `GET /{chainId}/status`（状態）
- `GET /{chainId}/mempool`（mempool）

### 4.2 ブロック・Tx
- `GET /{chainId}/blocks/latest`
- `GET /{chainId}/blocks/{height}`
- `GET /{chainId}/blocks/{height}/txs`
- `GET /{chainId}/tx/{txhash}`

### 4.3 アカウント
- `GET /{chainId}/accounts/{address}`

### 4.4 Tx送信
- `POST /{chainId}/simulate`
- `POST /{chainId}/broadcast`

### 4.5 観測（第2層）
- `GET /{chainId}/blocktime`

> “tx confirmation の待機” は第3層 Utilities にも存在するが、第2層では最小限（単発観測）に留める。

---

## 5. 各API仕様（第2層）

## 5.1 GET /
チェーン一覧を返す（Pod 起点）。

### Query
- `include` (optional): `endpoints` を指定すると endpoint 解決を試みる  
  例: `include=endpoints`
- `mode` (optional, default=auto): `external|internal|auto`

### Response
- 200:
```json
{
  "items": [
    { "chainId": "gwc", "pod": { "name": "cryptomeria-gwc-0", "ready": true } },
    { "chainId": "mdsc", "pod": { "name": "cryptomeria-mdsc-0", "ready": true } }
  ]
}
```

### エラー
- 503: `UPSTREAM_UNAVAILABLE`（K8s APIに到達不可等）

---

## 5.2 GET /{chainId}/info
チェーンの基本情報（chain-id、node info、latest block など）を返す。  
（上流が Tendermint RPC / Cosmos SDK REST のいずれかになる）

### Query
- `mode` (optional, default=auto)

### Response (200) 例
```json
{
  "chainId": "gwc",
  "nodeInfo": { "id": "...", "network": "gwc", "version": "..." },
  "syncInfo": { "latestBlockHeight": "12345", "latestBlockTime": "2026-01-23T09:00:00Z" }
}
```

### エラー
- 404: chainId 不明（Podが無い）
- 503/502: 上流到達不可/上流エラー

---

## 5.3 GET /{chainId}/status
上流の status を返す（簡易ヘルス）。

### Response (200) 例
```json
{
  "latestHeight": 12345,
  "latestTime": "2026-01-23T09:00:00Z",
  "catchingUp": false,
  "peerCount": 5
}
```

---

## 5.4 GET /{chainId}/mempool
mempool 情報を返す。

### Response (200) 例
```json
{
  "size": 10,
  "txs": ["base64...", "base64..."]
}
```

---

## 5.5 GET /{chainId}/blocks/latest
最新ブロックの要約を返す。

### Response (200)
```json
{
  "height": 12345,
  "hash": "....",
  "time": "2026-01-23T09:00:00Z",
  "txCount": 12
}
```

---

## 5.6 GET /{chainId}/blocks/{height}
指定 height のブロック要約（または詳細）を返す。

### Path
- `height` (required, integer)

### Query
- `detail` (optional, default=false): true で header/body をより多く返す

### Response (200)
```json
{
  "height": 12340,
  "hash": "....",
  "time": "2026-01-23T08:59:00Z",
  "txCount": 3
}
```

---

## 5.7 GET /{chainId}/blocks/{height}/txs
指定 height の Tx 一覧（txhash や decoded の要約）を返す。

### Query
- `format` (optional, default=hash): `hash|base64`
  - `hash`: txhash の配列
  - `base64`: tx（base64）の配列（サイズに注意）

### Response (200) 例
```json
{
  "height": 12340,
  "txs": ["ABCDEF...", "123456..."]
}
```

---

## 5.8 GET /{chainId}/tx/{txhash}
txhash で Tx 結果を取得する。

### Response (200) 例
```json
{
  "txhash": "ABCDEF...",
  "height": 12340,
  "code": 0,
  "rawLog": "...",
  "events": [{ "type": "transfer", "attributes": [{ "key": "amount", "value": "1token" }] }]
}
```

### エラー
- 404: 未確定/見つからない（上流仕様に合わせる）

---

## 5.9 GET /{chainId}/accounts/{address}
アカウント情報（balance, accountNumber, sequence 等）を返す。

### Response (200) 例
```json
{
  "address": "cosmos1....",
  "accountNumber": "12",
  "sequence": "34",
  "balances": [{ "denom": "stake", "amount": "1000" }]
}
```

---

## 5.10 POST /{chainId}/simulate
Tx を simulate（ガス見積もり）する。

### Request
```json
{
  "txBytesBase64": "...."
}
```

### Response (200)
```json
{
  "gasWanted": "200000",
  "gasUsed": "180000"
}
```

---

## 5.11 POST /{chainId}/broadcast
署名済みTxをブロードキャストする。

### Request
```json
{
  "txBytesBase64": "....",
  "broadcastMode": "sync"
}
```

- `broadcastMode`: `async|sync|block`（上流対応に合わせる）

### Response (200)
- `TxBroadcastResult`

---

# 6. 観測: GET /{chainId}/blocktime

## 6.1 目的
指定 window の範囲でブロックヘッダ時刻を用いてブロック時間を算出し、統計値を返す。  
**ブロックヘッダ時刻ベース**であり、wall-clock を用いない（比較可能性のため）。

## 6.2 定義（固定）
- `endHeight = latestHeight`（status/info から取得）
- `startHeight = endHeight - window + 1`
- 各ブロックの `header.time` を取得して時系列 `t[start..end]` を得る
- 差分系列:
  - `delta[i] = t[i] - t[i-1]`（i = start+1 .. end）
- 統計:
  - `meanSeconds`: delta の平均
  - `minSeconds`: delta の最小
  - `maxSeconds`: delta の最大
  - `p50/p90/p99Seconds`: 分位（必要に応じて）

> window=100 の場合、delta は 99 個。  
> 返却には `range` と `timeStart/timeEnd` を必ず含め、算出根拠を明確にする。

## 6.3 Query
- `window` (optional, default=100, min=2, max=2000)
- `mode` (optional, default=auto)
- `useCache` (optional, default=true)
- `ttlSeconds` (optional, default=10) : v1では上限 60 を推奨

## 6.4 Response (200) 例
```json
{
  "chainId": "gwc",
  "window": 100,
  "range": { "startHeight": 12246, "endHeight": 12345 },
  "timeStart": "2026-01-23T08:58:20Z",
  "timeEnd": "2026-01-23T09:00:00Z",
  "durationSeconds": 100,
  "stats": {
    "meanSeconds": 1.01,
    "minSeconds": 0.97,
    "maxSeconds": 1.20,
    "p50Seconds": 1.00,
    "p90Seconds": 1.05,
    "p99Seconds": 1.18
  },
  "cached": true,
  "computedAt": "2026-01-23T09:00:01Z"
}
```

---

## 7. blocktime キャッシュ仕様（実装直結の簡易フロー）

### 7.1 キャッシュキー
- `key = chainId + ":" + mode + ":" + window`

### 7.2 キャッシュ値
```json
{
  "latestHeight": 12345,
  "window": 100,
  "range": { "startHeight": 12246, "endHeight": 12345 },
  "stats": { "...": "..." },
  "timeStart": "2026-01-23T08:58:20Z",
  "timeEnd": "2026-01-23T09:00:00Z",
  "computedAt": "2026-01-23T09:00:01Z",
  "expiresAt": "2026-01-23T09:00:11Z"
}
```

### 7.3 フロー（擬似）
1. `latestHeight` を取得（`/status` 等）
2. `startHeight = latestHeight - window + 1`
3. `useCache=true` の場合:
   - キャッシュに `key` が存在し
   - `cache.latestHeight == latestHeight`
   - `now < cache.expiresAt`
   → **キャッシュ返却**
4. そうでなければ:
   - `[startHeight..latestHeight]` の `header.time` を取得
   - delta を計算して stats を算出
   - `expiresAt = now + ttlSeconds`
   - キャッシュ保存して返却

### 7.4 キャッシュ上限（推奨）
- 最大エントリ数: 100（LRU）
- ttlSeconds: 5〜15秒推奨（上流負荷と実験用途のバランス）

---

## 8. 非対応（v1スコープ外）
- 署名生成（BFFは署名済み txBytes のみ受け付ける）
- WebSocket ストリーム（必要なら v2 で追加）
- 大規模のバッチ観測（Utilities層へ）

---

## 9. 変更履歴
- 1.0.0: v1 初版（Pod起点の chain list、blocktime固定定義＋キャッシュフローを規定）
