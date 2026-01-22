# 第2層 API仕様書：Blockchain（チェーン操作API）
Version: v1（Draft）  
BasePath: `/api/v1`  
Prefix: `/chains`

> 本仕様書は **第2層（Blockchain）** のみを対象とする。  
> 目的は、cryptomeriaシステム内部の「ブロックチェーンに関する処理」をBFF経由で統一的に提供すること。  
> 具体的には、(1) チェーンの発見（どのchainIdが存在し、どのendpointで叩けるか）、(2) 参照（status/info/block/tx/account/balance）、(3) Tx操作（simulate/broadcast）、(4) 実験に必要な観測値（blocktime、block内tx一覧など）をAPIとして提供する。  
> 認証・権限・ADMIN等の概念は本要件から撤廃し、仕様書でも扱わない。

---

## 1. 共通仕様（Blockchain層）

### 1.1 データ形式
- `Content-Type: application/json; charset=utf-8`
- Request/Response は原則 JSON

### 1.2 成功/エラーの基本形
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

### 1.3 エラーコード（代表例）
- `CHAIN_NOT_FOUND`：chainIdが存在しない
- `UPSTREAM_UNREACHABLE`：対象チェーンのRPC/RESTに接続できない
- `UPSTREAM_ERROR`：上流（Cosmos/Tendermint）からエラー応答
- `INVALID_ADDRESS`：address形式不正
- `INVALID_HEIGHT`：heightが数値でない/範囲外
- `INVALID_TX_BYTES`：txBytesがbase64として不正、またはデコード不可
- `TIMEOUT`：上流呼び出しがタイムアウト
- `INTERNAL_ERROR`：BFF内部例外

### 1.4 chainIdとエンドポイント解決の前提
- `chainId` は原則、k8sの `app.kubernetes.io/instance`（例：`mdsc`, `fdsc-0`）に対応する。
- BFFは `chainId -> endpoints` を内部で解決する。
  - `rpc`：Tendermint RPC（既定 26657）
  - `api`：Cosmos REST（既定 1317）
  - `grpc`：Cosmos gRPC（既定 9090）
- `/chains`（チェーン一覧）で、解決済みのendpointsを返せるようにする。

---

## 2. データモデル（レスポンス内構造）

### 2.1 ChainEndpoints
```json
{
  "rpc": "http://<host>:<port>",
  "api": "http://<host>:<port>",
  "grpc": "<host>:<port>"
}
```

### 2.2 ChainSummary（/chains一覧の1要素）
```json
{
  "chainId": "mdsc",
  "endpoints": {
    "rpc": "http://192.168.49.2:31057",
    "api": "http://192.168.49.2:30317",
    "grpc": "192.168.49.2:30090"
  },
  "ports": { "rpc": 26657, "api": 1317, "grpc": 9090 },
  "meta": {
    "component": "mdsc",
    "instance": "mdsc",
    "source": "k8s.service.nodeport"
  }
}
```

### 2.3 TxBroadcastResult（broadcast結果）
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

---

## 3. エンドポイント仕様（Blockchain層）

## 3.1 GET `/chains`（チェーン一覧・発見）
- **目的**  
  利用可能な `chainId` 一覧と、各チェーンの接続先（rpc/api/grpc）を返す。
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

#### Query Parameters（任意）
- `mode`：`external|internal|auto`（既定 `auto`）  
  - `external`：NodePort等で外部から叩けるendpointを返す想定  
  - `internal`：クラスタ内DNS/ClusterIPで叩けるendpointを返す想定  
  - `auto`：BFFの配置（クラスタ内/外）や設定で自動
- `include`：`endpoints|ports|meta`（複数可、既定 全て）

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "chainId": "mdsc",
        "endpoints": {
          "rpc": "http://192.168.49.2:31057",
          "api": "http://192.168.49.2:30317",
          "grpc": "192.168.49.2:30090"
        },
        "ports": { "rpc": 26657, "api": 1317, "grpc": 9090 },
        "meta": { "component": "mdsc", "instance": "mdsc", "source": "k8s.service.nodeport" }
      }
    ]
  }
}
```

#### エラー
- `500`：k8s参照失敗等（チェーン発見ができない）

---

## 3.2 GET `/chains/{chainId}/info`（チェーン基本情報）
- **目的**  
  チェーンの基本情報（chain-id, node info, version等）を取得する。
- **何を提供するか**  
  - node_info / application_version / network など（上流仕様に準拠）
- **どんなことに使えるか**  
  - 疎通確認、環境差分の検知
- **内部的に必要な情報**  
  - chainId -> rpc/api 解決
  - 上流API呼び出し（Tendermint RPC /node_info 等）

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "chainId": "mdsc",
    "nodeInfo": {
      "id": "node-id",
      "network": "mdsc",
      "version": "0.34.x"
    },
    "appVersion": { "version": "v0.1.0" }
  }
}
```

#### エラー
- `404`：`CHAIN_NOT_FOUND`
- `502/500`：`UPSTREAM_UNREACHABLE` / `UPSTREAM_ERROR`

---

## 3.3 GET `/chains/{chainId}/status`（同期状態）
- **目的**  
  同期状態・最新ブロック高・時刻を取得する。
- **何を提供するか**  
  - `latestHeight`, `latestTime`, `catchingUp` 等
- **どんなことに使えるか**  
  - 実験開始条件（同期済みか）判定
  - 監視・ヘルスチェック
- **内部的に必要な情報**  
  - rpc endpoint
  - Tendermint RPC `status` 相当

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "chainId": "mdsc",
    "latestHeight": "1234",
    "latestTime": "2026-01-23T12:00:00Z",
    "catchingUp": false
  }
}
```

---

## 3.4 GET `/chains/{chainId}/accounts/{address}`（アカウント情報）
- **目的**  
  Tx署名に必要な account_number / sequence を含むアカウント情報を取得する。
- **何を提供するか**  
  - accountオブジェクト（上流のauthモジュールに準拠）
- **どんなことに使えるか**  
  - 署名・nonce管理
  - 送金等の前提確認
- **内部的に必要な情報**  
  - rest endpoint
  - address validation（bech32）

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "address": "cosmos1....",
    "accountNumber": "12",
    "sequence": "34",
    "raw": { }
  }
}
```

#### エラー
- `422`：`INVALID_ADDRESS`
- `404`：`CHAIN_NOT_FOUND`

---

## 3.5 GET `/chains/{chainId}/balances/{address}`（残高）
- **目的**  
  アドレスの残高一覧（denom別）を取得する。
- **何を提供するか**  
  - balances配列
- **どんなことに使えるか**  
  - 実験前後の残高比較
  - faucet/負荷試験の準備確認
- **内部的に必要な情報**  
  - rest endpoint
  - denom情報（必要なら）

#### Query Parameters（任意）
- `denom`：特定denomだけ返す

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "address": "cosmos1....",
    "balances": [
      { "denom": "stake", "amount": "1000000" }
    ]
  }
}
```

---

## 3.6 POST `/chains/{chainId}/simulate`（Txシミュレーション）
- **目的**  
  txBytesの実行シミュレーションを行い、gas見積もりや失敗理由を返す。
- **何を提供するか**  
  - `gasUsed`, `gasWanted`, `result/logs` 等
- **どんなことに使えるか**  
  - fee設計、失敗の事前検知
- **内部的に必要な情報**  
  - simulate呼び出し（gRPC or REST）
  - txBytesのbase64デコード

#### Request
```json
{
  "txBytes": "<base64>",
  "mode": "grpc"
}
```

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "gasUsed": "12345",
    "gasWanted": "20000",
    "raw": { }
  }
}
```

#### エラー
- `422`：`INVALID_TX_BYTES`
- `502/500`：上流エラー

---

## 3.7 POST `/chains/{chainId}/broadcast`（Txブロードキャスト）
- **目的**  
  署名済み `txBytes` をチェーンへ送信し、txhash等を返す。
- **何を提供するか**  
  - `txhash`, `code`, `rawLog` 等（ブロードキャスト結果）
- **どんなことに使えるか**  
  - 実験用Tx投入の統一窓口
- **内部的に必要な情報**  
  - broadcast呼び出し（gRPC or REST）
  - mode（sync/async/block）の扱い

#### Request
```json
{
  "txBytes": "<base64>",
  "broadcastMode": "sync"
}
```

- `broadcastMode`：`sync|async|block`（既定 `sync`）

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "txhash": "ABCDEF...",
    "code": 0,
    "rawLog": "",
    "height": "123"
  }
}
```

#### エラー
- `422`：`INVALID_TX_BYTES`
- `502/500`：上流エラー

---

## 3.8 GET `/chains/{chainId}/tx/{txhash}`（Tx結果）
- **目的**  
  txhashからTx結果（成功/失敗、ログ、ガス、イベント等）を取得する。
- **何を提供するか**  
  - tx_response（上流準拠）または整形済みサマリ
- **どんなことに使えるか**  
  - confirmation観測、失敗解析
- **内部的に必要な情報**  
  - rest endpoint
  - tx照会の仕様（/cosmos/tx/v1beta1/txs/{hash} 等）

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "txhash": "ABCDEF...",
    "height": "123",
    "code": 0,
    "rawLog": "",
    "events": [ ]
  }
}
```

#### エラー
- `404`：Txがまだ見つからない（見つからない理由を `details` に含める）

---

## 3.9 GET `/chains/{chainId}/mempool`（mempool観測）
- **目的**  
  mempoolの状態を取得する（混雑観測）。
- **何を提供するか**  
  - pending tx数等（可能な範囲）
- **どんなことに使えるか**  
  - 負荷試験の前後比較
- **内部的に必要な情報**  
  - rpc endpoint
  - 上流のmempool関連API（取得可能な範囲に依存）

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "pendingCount": 10,
    "raw": { }
  }
}
```

---

## 3.10 GET `/chains/{chainId}/blocks/latest`（最新ブロック）
- **目的**  
  最新ブロック情報を取得する。
- **何を提供するか**  
  - header/body（必要最小）または上流生レスポンス
- **どんなことに使えるか**  
  - ブロック時間計測の素材
  - 同期確認の補助
- **内部的に必要な情報**  
  - rpc endpoint（block? height等）

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "height": "1234",
    "time": "2026-01-23T12:00:00Z",
    "txCount": 3,
    "raw": { }
  }
}
```

---

## 3.11 GET `/chains/{chainId}/blocks/{height}`（指定高ブロック）
- **目的**  
  指定したheightのブロックを取得する。
- **何を提供するか**  
  - header/body（必要最小）
- **どんなことに使えるか**  
  - 区間分析、デバッグ
- **内部的に必要な情報**  
  - rpc endpoint

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "height": "1200",
    "time": "2026-01-23T11:59:00Z",
    "txCount": 0,
    "raw": { }
  }
}
```

#### エラー
- `422`：`INVALID_HEIGHT`

---

## 3.12 GET `/chains/{chainId}/blocks/{height}/txs`（ブロック内Tx一覧）
- **目的**  
  指定ブロックに含まれるTx一覧を返す（実験でTPS算出等に必要）。
- **何を提供するか**  
  - txhash配列、またはTx要約配列
- **どんなことに使えるか**  
  - TPS算出、Tx分布解析
- **内部的に必要な情報**  
  - ブロック取得（Txデータ含む形式）
  - 形式に応じて `txs[]` を抽出・整形

#### Query Parameters（任意）
- `format`：`hashes|summary|raw`（既定 `hashes`）
- `limit`：返却数上限（既定：全件）

#### Response（hashes）
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "height": "1200",
    "items": [
      { "txhash": "AAA..." },
      { "txhash": "BBB..." }
    ]
  }
}
```

---

## 3.13 GET `/chains/{chainId}/blocktime`（ブロック時間統計）
- **目的**  
  最新Nブロックの時刻差からブロック生成間隔の統計値を返す。
- **何を提供するか**  
  - window内の平均/中央値/分位、min/max、標準偏差
- **どんなことに使えるか**  
  - 卒研の評価指標（ブロック時間）
  - スケール時の変化測定
- **内部的に必要な情報**  
  - window分のブロックheader time取得
  - （推奨）短期キャッシュ（同一window要求の負荷軽減）

#### Query Parameters（任意）
- `window`：最新何ブロックを見るか（既定 100、範囲 2〜2000 推奨）
- `percentiles`：例 `50,90,95,99`（既定 `50,95`）

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "chainId": "mdsc",
    "window": 100,
    "sampleCount": 99,
    "unit": "seconds",
    "stats": {
      "mean": 1.02,
      "min": 0.88,
      "max": 1.40,
      "stddev": 0.08,
      "p50": 1.01,
      "p95": 1.18
    },
    "range": {
      "fromHeight": "1135",
      "toHeight": "1234",
      "fromTime": "2026-01-23T11:58:20Z",
      "toTime": "2026-01-23T12:00:00Z"
    }
  }
}
```

#### エラー
- `422`：window範囲外、percentiles不正

---

## 3.14 POST `/chains/{chainId}/tx/decode`（Txデコード）
- **目的**  
  `txBytes` をデコードして、人間/ツールが扱いやすいJSONへ変換する。
- **何を提供するか**  
  - msgs/fee/memo/signatures 等の抽出情報（可能な範囲）
- **どんなことに使えるか**  
  - 失敗Tx分析、実験ログ整形
- **内部的に必要な情報**  
  - protobuf定義 or 上流decode手段
  - base64デコード

#### Request
```json
{
  "txBytes": "<base64>",
  "mode": "bestEffort"
}
```

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "body": { "messages": [ ], "memo": "" },
    "authInfo": { "fee": { "amount": [ ], "gasLimit": "20000" } },
    "signatures": [ "..." ],
    "raw": { }
  }
}
```

---

## 3.15 POST `/chains/{chainId}/tx/build`（任意：署名素材生成）
> 署名はクライアント側で実施する前提で、signDoc素材を生成する補助API。  
> 実験クライアントの実装負荷を下げる目的で、必要になった段階で導入する。

- **目的**  
  Tx構築に必要な素材（accountNumber/sequence、bodyBytes/authInfoBytes等）を生成する。
- **何を提供するか**  
  - signDocに相当する情報（署名は含めない）
  - （任意）simulateと組み合わせた推奨gas/fee
- **どんなことに使えるか**  
  - 実験コードの簡略化（protobuf構築をBFF側に寄せる）
- **内部的に必要な情報**  
  - account情報取得（/accounts）
  - protobuf構築ロジック
  - simulate連携（任意）

#### Request（例）
```json
{
  "fromAddress": "cosmos1....",
  "messages": [
    { "typeUrl": "/cosmos.bank.v1beta1.MsgSend", "value": { } }
  ],
  "memo": "",
  "fee": { "amount": [{ "denom": "stake", "amount": "1000" }], "gasLimit": "200000" },
  "timeoutHeight": "0"
}
```

#### Response（例）
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "chainId": "mdsc",
    "accountNumber": "12",
    "sequence": "34",
    "bodyBytes": "<base64>",
    "authInfoBytes": "<base64>",
    "signDocBytes": "<base64>",
    "note": "signDocBytes is provided for client-side signing"
  }
}
```

---

## 4. 実装上の注意（Blockchain層の落とし穴）
- `chainId` は “k8s上のinstance名” と “チェーンのnetwork/chain-id” が一致しない可能性がある  
  → 返却では `chainId`（APIキー）と、`info`で得られる `network`（上流値）を両方出すと安全。
- 上流API（RPC/REST/gRPC）の差分吸収が必要  
  → 可能な限り “BFFの整形レスポンス” を固定し、`raw` で上流生を添付する設計が便利。
- `blocks/{height}/txs` は上流の返す形式に依存する  
  → 最低限 `hashes` 形式で返せるようにし、`raw` はオプションにするのが堅い。
- `blocktime` は大量のblock headerを取るので、短期キャッシュ（数秒〜数十秒）推奨。

---
