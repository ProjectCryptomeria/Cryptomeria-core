# API第二層仕様書（Blockchain Layer）／第2層 API仕様書：Blockchain（チェーン操作API）

- 対象: Cryptomeria-BFF v1
- Version: v1（Draft）
- 版: 1.0.0
- 最終更新: 2026-01-23
- Base Path: `/api/v1/chains`（= `/api/v1` + `/chains`）

> 本仕様書は **第2層（Blockchain）** のみを対象とする。  
> 目的は、cryptomeriaシステム内部の「ブロックチェーンに関する処理」をBFF経由で統一的に提供すること。  
> 具体的には、(1) チェーンの発見（どのchainIdが存在し、どのendpointで叩けるか）、(2) 参照（status/info/block/tx/account/balance）、(3) Tx操作（simulate/broadcast）、(4) 実験に必要な観測値（blocktime、block内tx一覧など）をAPIとして提供する。  
> 認証・権限・ADMIN等の概念は本要件から撤廃し、仕様書でも扱わない。

この層の目的:
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

### 1.2 chainIdとエンドポイント解決の前提
- `chainId` は原則、k8sの `app.kubernetes.io/instance`（例：`mdsc`, `fdsc-0`）に対応する。
- BFFは `chainId -> endpoints` を内部で解決する。
  - `rpc`：Tendermint RPC（既定 26657）
  - `rest`：Cosmos REST（既定 1317）
  - `grpc`：Cosmos gRPC（既定 9090）
- `/chains`（チェーン一覧）で、解決済みのendpointsを返せるようにする。

### 1.3 endpoint 解決（必要時のみ）
- エンドポイント（RPC/RESTなど）の解決は以下のいずれかで行う:
  1) BFFの環境変数（固定 endpoint）
  2) K8s Service/Endpoints の discovery（NodePort/ClusterIP 等）

### 1.4 mode
- `mode=external|internal|auto` をサポートする（v1）。
  - `external`: NodePort 等、クラスタ外から到達可能な endpoint を優先
  - `internal`: ClusterIP / PodDNS 等、クラスタ内到達を想定（BFFが外部の場合でも定義は残す）
  - `auto`: 利用可能なものを優先順で選択

---

## 2. 共通仕様（Blockchain層）

### 2.1 データ形式 / Content-Type
- `Content-Type: application/json; charset=utf-8`
- Request/Response は原則 JSON

### 2.2 時刻
- すべて ISO 8601（UTC推奨）例: `2026-01-23T09:00:00Z`

### 2.3 成功/エラーの基本形（旧仕様書より）
- 成功（基本）：
```json
{ "ok": true, "data": {} }
```

- エラー（基本）：
```json
{
  "ok": false,
  "error": {
    "code": "SOME_CODE",
    "message": "human readable message",
    "details": { }
  }
}
```

### 2.4 エラー形式（共通・新仕様書）
```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "chainId is unknown",
    "details": { "chainId": "gwc" }
  }
}
```

代表 code（新）:
- `INVALID_ARGUMENT` (400)
- `NOT_FOUND` (404)
- `UPSTREAM_UNAVAILABLE` (503) : RPC/REST 到達不可
- `UPSTREAM_ERROR` (502) : 上流がエラー
- `INTERNAL` (500)

エラーコード（代表例・旧）:
- `CHAIN_NOT_FOUND`：chainIdが存在しない
- `UPSTREAM_UNREACHABLE`：対象チェーンのRPC/RESTに接続できない
- `UPSTREAM_ERROR`：上流（Cosmos/Tendermint）からエラー応答
- `INVALID_ADDRESS`：address形式不正
- `INVALID_HEIGHT`：heightが数値でない/範囲外
- `INVALID_TX_BYTES`：txBytesがbase64として不正、またはデコード不可
- `TIMEOUT`：上流呼び出しがタイムアウト
- `INTERNAL_ERROR`：BFF内部例外

---

## 3. データモデル（第2層）

### 3.1 ChainEndpoints
```json
{
  "rpc": "http://<host>:<port>",
  "rest": "http://<host>:<port>",
  "grpc": "<host>:<port>"
}
```

### 3.2 ChainSummary（/chains一覧の1要素）
```json
{
  "chainId": "mdsc",
  "pod": { "name": "cryptomeria-mdsc-0", "ready": true },
  "endpoints": {
    "rpc": "http://192.168.49.2:31057",
    "rest": "http://192.168.49.2:30317",
    "grpc": "192.168.49.2:30090"
  },
  "ports": { "rpc": 26657, "rest": 1317, "grpc": 9090 },
  "meta": {
    "component": "mdsc",
    "instance": "mdsc",
    "source": "k8s.service.nodeport"
  }
}
```

### 3.3 TxBroadcastResult（broadcast結果）
```json
{
  "txhash": "ABCDEF...",
  "code": 0,
  "rawLog": "...",
  "height": "123",
  "gasUsed": "12345",
  "gasWanted": "20000"
}
```

### 3.4 BlockSummary
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
- `GET /api/v1/chains`（チェーン一覧）
- `GET /api/v1/chains/{chainId}/info`（基本情報）
- `GET /api/v1/chains/{chainId}/status`（状態）
- `GET /api/v1/chains/{chainId}/mempool`（mempool）

### 4.2 ブロック・Tx
- `GET /api/v1/chains/{chainId}/blocks/latest`
- `GET /api/v1/chains/{chainId}/blocks/{height}`
- `GET /api/v1/chains/{chainId}/blocks/{height}/txs`
- `GET /api/v1/chains/{chainId}/tx/{txhash}`

### 4.3 アカウント
- `GET /api/v1/chains/{chainId}/accounts/{address}`
- `GET /api/v1/chains/{chainId}/balances/{address}`（旧仕様書に記載）

### 4.4 Tx送信
- `POST /api/v1/chains/{chainId}/simulate`
- `POST /api/v1/chains/{chainId}/broadcast`

### 4.5 観測（第2層）
- `GET /api/v1/chains/{chainId}/blocktime`

> “tx confirmation の待機” は第3層 Utilities にも存在するが、第2層では最小限（単発観測）に留める。

### 4.6 Txユーティリティ（旧仕様書に記載）
- `POST /api/v1/chains/{chainId}/tx/decode`（Txデコード）
- `POST /api/v1/chains/{chainId}/tx/build`（任意：署名素材生成）

---

## 5. 各API仕様（第2層）

## 5.1 GET `/api/v1/chains`（チェーン一覧・発見）
- **目的**  
  利用可能な `chainId` 一覧と、各チェーンの接続先（rpc/rest/grpc）を返す。
- **何を提供するか**  
  - `chainId` 配列（mdsc, fdsc-0, ...）
  - それぞれのendpoints（外部向け/内部向けのどちらか、または両方）
  - 追加メタデータ（k8s由来の情報など）
- **どんなことに使えるか**  
  - 実験クライアントが chainId を自動列挙
  - 接続先をコードに直書きしない運用（環境差の吸収）
- **内部的に必要な情報**  
  - k8s Service discovery（NodePort/ClusterIP）
  - chainId抽出ルール（instanceラベル推奨）
  - nodeHost（NodePortアクセス時）

### Query Parameters（任意）
- `mode`：`external|internal|auto`（既定 `auto`）
- `include`：
  - 新仕様書: `endpoints` を指定すると endpoint 解決を試みる（例: `include=endpoints`）
  - 旧仕様書: `endpoints|ports|meta`（複数可）

### Response（例）
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
- 500: k8s参照失敗等（チェーン発見ができない）

---

## 5.2 GET `/api/v1/chains/{chainId}/info`（チェーン基本情報）
- **目的**  
  チェーンの基本情報（chain-id、node info、latest block など）を返す。  
  （上流が Tendermint RPC / Cosmos SDK REST のいずれかになる）
- **内部的に必要な情報**  
  - chainId -> rpc/rest 解決
  - 上流API呼び出し（Tendermint RPC /node_info 等）

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
- 404: chainId 不明
