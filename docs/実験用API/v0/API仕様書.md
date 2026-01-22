# Cryptomeria 実験用BFFサーバー API仕様書 v1

## 0. 文書情報

* 対象：実験用BFFサーバー（Backend For Frontend）
* APIプレフィックス：`/api/v1`
* レスポンス形式：JSON
* 認証：Bearer token（最小限）
* 永続化：しない（DBなし）
* 署名：しない（秘密鍵を持たない）

---

## 1. 目的と非目的

### 1.1 目的

* 実験の手順を単純化するため、以下をBFFで提供する：

  * チェーンのエンドポイント動的解決（Kubernetes NodePort Service）
  * 署名に必要な材料（accountNumber / sequence）の提供
  * simulate / broadcast（署名済みTxの中継）
  * 観測（status/tx確認など）※要件に含まれる範囲で

### 1.2 非目的（やらないこと）

* 秘密鍵の保管、署名の実行
* Txを内容理解して加工（最小限の抜粋・透過のみ）
* DBなどの永続ストレージ
* 実験ログの保存

---

## 2. 前提（Kubernetes / Cryptomeria構成）

### 2.1 Kubernetes

* BFFは Kubernetes API にアクセスできること（クラスタ外実行でも可）
* BFFは Namespace 内の NodePort Service を参照して endpoint を解決する

### 2.2 Service命名（採用ルール）

* 対象Service：**`type: NodePort`**
* 対象Service名：`cryptomeria-{chainId}` に一致するものを採用

### 2.3 Service port 名（採用ルール）

NodePort Service の `spec.ports[].name` を使って判定する：

* `api` → REST base
* `rpc` → RPC base（HTTP）/ WS
* `grpc` → gRPC address

---

## 3. 用語と識別子

### 3.1 chainId

* 許可される形式（v1固定）：

  * `gwc`
  * `mdsc`
  * `fdsc-{n}`（例：`fdsc-0`, `fdsc-1` …）
* `GET /chains` は Kubernetes上の Service 実在から動的に列挙する

### 3.2 nodeHost

* NodePort にアクセスするためのホスト名/IP
* v1の既定：**環境変数 `NODE_HOST` を必須**（自動推定は任意機能）

---

## 4. 共通仕様

### 4.1 HTTP

* Base Path：`/api/v1`
* Content-Type：`application/json; charset=utf-8`
* 受理：`application/json`
* 文字コード：UTF-8

### 4.2 認証（最小限）

* すべてのAPIで `Authorization: Bearer <token>` を要求
* token は BFF の環境変数 `API_TOKEN` と一致する必要がある
* 認証エラー：`401 Unauthorized`

### 4.3 タイムアウト（下流呼び出し）

* 既定：**10秒**
* 環境変数 `DOWNSTREAM_TIMEOUT_MS` で上書き可

### 4.4 サイズ制限

* `txBytesBase64` の最大長（文字数）を制限する
* 既定：**5,000,000 文字**
* 環境変数 `MAX_TX_BASE64_CHARS` で上書き可
* 超過時：`413 Payload Too Large`

### 4.5 キャッシュ

* Endpoint Discovery（Service→NodePort解決）は短命キャッシュ可
* 既定：**10秒**
* 環境変数 `ENDPOINT_CACHE_TTL_MS` で上書き可

### 4.6 エラーレスポンス（統一形式）

エラー時は必ず以下を返す：

```json
{
  "error": {
    "code": "STRING_CODE",
    "message": "human readable",
    "details": { }
  }
}
```

* `details` は省略可
* HTTPステータスは 7章参照

---

## 5. 環境変数（v1）

| 変数                      | 必須 |            既定 | 説明                   |
| ----------------------- | -: | ------------: | -------------------- |
| `API_TOKEN`             |  ✅ |             - | Bearer token の照合値    |
| `K8S_NAMESPACE`         |  ✅ | `cryptomeria` | 対象Namespace          |
| `NODE_HOST`             |  ✅ |             - | NodePortへ到達できるホスト/IP |
| `DOWNSTREAM_TIMEOUT_MS` |    |       `10000` | 下流HTTP/RPCタイムアウト     |
| `MAX_TX_BASE64_CHARS`   |    |     `5000000` | payload制限            |
| `ENDPOINT_CACHE_TTL_MS` |    |       `10000` | endpoint解決キャッシュTTL   |
| `AUTO_DETECT_NODE_HOST` |    |       `false` | trueで自動推定（任意機能）      |

> v1では **`NODE_HOST` を指定すれば必ず動く** を保証範囲とする（自動推定は任意）。

---

## 6. データモデル

### 6.1 ChainSummary

```json
{
  "chainId": "gwc",
  "serviceName": "cryptomeria-gwc"
}
```

### 6.2 ChainInfo

```json
{
  "chainId": "gwc",
  "serviceName": "cryptomeria-gwc",
  "restBase": "http://<nodeHost>:<apiNodePort>",
  "rpcBase": "http://<nodeHost>:<rpcNodePort>",
  "wsRpcUrl": "ws://<nodeHost>:<rpcNodePort>/websocket",
  "grpcAddr": "<nodeHost>:<grpcNodePort>"
}
```

* `wsRpcUrl` / `grpcAddr` は、該当portが存在する場合のみ返す（存在しなければ省略）

### 6.3 AccountInfo

```json
{
  "address": "cosmos1....",
  "accountNumber": "12",
  "sequence": "34"
}
```

* v1固定：`accountNumber` と `sequence` は **string**

### 6.4 SimulateRequest / Response

```json
{
  "txBytesBase64": "AAAA...."
}
```

```json
{
  "gasUsed": "12345",
  "gasWanted": "20000",
  "raw": { }
}
```

* `gasUsed/gasWanted` は string（下流の値を安全に透過）
* `raw` は下流レスポンスの透過（実装依存でOKだが、最低限 `gasUsed/gasWanted` は返す）

### 6.5 BroadcastRequest / Response

```json
{
  "txBytesBase64": "AAAA....",
  "mode": "sync"
}
```

```json
{
  "txhash": "ABCDEF...",
  "broadcastResult": { },
  "observedAt": "2026-01-19T00:00:00Z"
}
```

* `mode` 省略時の既定：`sync`
* `observedAt` はBFFが応答した時刻（ISO8601）

---

## 7. HTTPステータスと error.code

| HTTP | code                | 例                                             |
| ---: | ------------------- | --------------------------------------------- |
|  400 | `INVALID_INPUT`     | chainId形式不正、base64不正、mode不正                   |
|  401 | `UNAUTHORIZED`      | token不一致、Authorization欠落                      |
|  404 | `NOT_FOUND`         | chainIdに対応するServiceが存在しない                     |
|  413 | `PAYLOAD_TOO_LARGE` | txBytesBase64が上限超過                            |
|  502 | `BAD_GATEWAY`       | K8s/下流が期待形式でない、port不足、下流4xx/5xxの透過を502扱いにする場合 |
|  504 | `GATEWAY_TIMEOUT`   | 下流タイムアウト                                      |
|  500 | `INTERNAL_ERROR`    | 予期せぬ例外                                        |

---

## 8. Endpoint Discovery 仕様（実装規約）

### 8.1 解決対象

* Namespace：`K8S_NAMESPACE`
* Service：`cryptomeria-{chainId}` かつ `spec.type == NodePort`

### 8.2 解決アルゴリズム（v1固定）

1. Service一覧から `serviceName` を特定
2. `spec.ports[]` を走査し、`name` が `api|rpc|grpc` のものを拾う
3. 各portの `nodePort` を採用し、`NODE_HOST` と結合して endpoint を生成
4. 結果を TTL 付きでメモリキャッシュ

### 8.3 エラー条件（v1固定）

* Serviceが無い → `404 NOT_FOUND`
* `api` が無い（REST不能）→ `502 BAD_GATEWAY`（`MISSING_SERVICE_PORT` 等をdetailsに入れてよい）
* simulate/broadcast等で必要なportが無い → `502 BAD_GATEWAY`

---

# 9. API一覧（v1）

## 9.1 GET /api/v1/chains

Kubernetes上の Cryptomeriaチェーン（NodePort Service）を列挙する。

### Response 200

```json
{
  "chains": [
    { "chainId": "gwc", "serviceName": "cryptomeria-gwc" },
    { "chainId": "mdsc", "serviceName": "cryptomeria-mdsc" },
    { "chainId": "fdsc-0", "serviceName": "cryptomeria-fdsc-0" }
  ]
}
```

### Errors

* 401 `UNAUTHORIZED`
* 502 `BAD_GATEWAY`（K8s API不可など）
* 504 `GATEWAY_TIMEOUT`（K8s到達タイムアウト扱いにする場合）

---

## 9.2 GET /api/v1/chains/{chainId}/info

指定チェーンの endpoint 解決結果を返す。

### Path Params

* `chainId`：3章の形式に一致

### Response 200

```json
{
  "chainId": "gwc",
  "serviceName": "cryptomeria-gwc",
  "restBase": "http://127.0.0.1:31317",
  "rpcBase": "http://127.0.0.1:32657",
  "wsRpcUrl": "ws://127.0.0.1:32657/websocket",
  "grpcAddr": "127.0.0.1:30090"
}
```

### Errors

* 400 `INVALID_INPUT`
* 401 `UNAUTHORIZED`
* 404 `NOT_FOUND`
* 502 `BAD_GATEWAY`
* 504 `GATEWAY_TIMEOUT`

---

## 9.3 GET /api/v1/chains/{chainId}/accounts/{address}

署名に必要な `accountNumber` と `sequence` を返す（BFFは署名しない）。

### Path Params

* `chainId`
* `address`：bech32など（厳密検証は任意。最低限空文字禁止）

### Response 200

```json
{
  "address": "cosmos1xxxxxxxx",
  "accountNumber": "12",
  "sequence": "34"
}
```

### Errors

* 400 `INVALID_INPUT`
* 401 `UNAUTHORIZED`
* 404 `NOT_FOUND`（chainId未解決）
* 502 `BAD_GATEWAY`（下流エラー）
* 504 `GATEWAY_TIMEOUT`

---

## 9.4 POST /api/v1/chains/{chainId}/simulate

署名済みTx（または署名前Txでも可）を simulate して gas を見積もる。
（下流へ透過的に渡し、BFFは最小限の整形のみ）

### Request Body

```json
{
  "txBytesBase64": "AAAA...."
}
```

### Response 200

```json
{
  "gasUsed": "12345",
  "gasWanted": "20000",
  "raw": { }
}
```

### Errors

* 400 `INVALID_INPUT`（base64不正、空、など）
* 401 `UNAUTHORIZED`
* 404 `NOT_FOUND`
* 413 `PAYLOAD_TOO_LARGE`
* 502 `BAD_GATEWAY`
* 504 `GATEWAY_TIMEOUT`

---

## 9.5 POST /api/v1/chains/{chainId}/broadcast

署名済みTxをブロードキャストする（BFFは署名しない）。

### Request Body

```json
{
  "txBytesBase64": "AAAA....",
  "mode": "sync"
}
```

* `mode`：`"sync" | "async" | "commit"`
* 省略時：`"sync"`

### Response 200

```json
{
  "txhash": "ABCDEF0123...",
  "broadcastResult": { },
  "observedAt": "2026-01-19T00:00:00Z"
}
```

### Errors

* 400 `INVALID_INPUT`
* 401 `UNAUTHORIZED`
* 404 `NOT_FOUND`
* 413 `PAYLOAD_TOO_LARGE`
* 502 `BAD_GATEWAY`
* 504 `GATEWAY_TIMEOUT`

---

## 10. ロギング（v1規約）

* **txBytesBase64 を全文ログに出さない**
* 記録してよい例：

  * `chainId`
  * `payloadSizeChars`
  * `mode`
  * `txhash`（取得できた場合）
  * 下流応答の `code` / `height` 等（必要最小限）

---

## 11. マネージャー構造（実装分割規約）

要件ドキュメントの3分割をv1規約として採用する：

1. `K8sManager`

* Service/Node/Pod参照、NodePort解決、短命キャッシュ

2. `CryptomeriaManager`

* 解決した `restBase/rpcBase` を使って下流呼び出し
* simulate / broadcast / account取得

3. `ClientApiManager`

* ルーティング、認証、入力検証、エラー整形

---

## 付録A. 代表的なエラー例

### 認証失敗

HTTP 401

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing or invalid bearer token"
  }
}
```

### chain未発見

HTTP 404

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Chain service not found",
    "details": { "chainId": "fdsc-9" }
  }
}
```

### payload超過

HTTP 413

```json
{
  "error": {
    "code": "PAYLOAD_TOO_LARGE",
    "message": "txBytesBase64 exceeds limit",
    "details": { "maxChars": 5000000 }
  }
}
```
