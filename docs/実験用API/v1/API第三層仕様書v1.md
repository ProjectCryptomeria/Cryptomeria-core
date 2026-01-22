# 第3層 API仕様書：Utilities（実験・観測・負荷・データ取得ユーティリティ）
Version: v1（Draft）  
BasePath: `/api/v1`  
Prefix: `/utils`

> 本仕様書は **第3層（Utilities）** のみを対象とする。  
> 目的は、卒研・実験・負荷試験・データ取得で頻出する「測る・まとめる・流す・記録する」をBFF側でユーティリティとして提供し、実験用スクリプト/クライアントを簡単にすること。  
> 第2層（Blockchain）を “部品API” として組み合わせ、統計・バッチ処理・スナップショット化・観測補助を行う。  
> 認証・権限・ADMIN等の概念は本要件から撤廃し、仕様書でも扱わない。

---

## 1. 共通仕様（Utilities層）

### 1.1 データ形式
- `Content-Type: application/json; charset=utf-8`
- ログ/ストリーム（将来）：`text/plain` / `application/x-ndjson` / `text/event-stream`（SSE）

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
    "details": {}
  }
}
```

### 1.3 代表エラーコード
- `CHAIN_NOT_FOUND`：chainIdが存在しない
- `INVALID_INPUT`：必須パラメータ欠落、型不正、範囲外
- `TIMEOUT`：待機がタイムアウト
- `UPSTREAM_UNREACHABLE`：チェーンRPC/RESTに到達不可
- `UPSTREAM_ERROR`：上流がエラー
- `RATE_LIMITED`：同時実行数制限等で拒否した
- `INTERNAL_ERROR`：BFF内部例外

### 1.4 タイムアウトの扱い
Utilitiesは「待つ」「たくさん叩く」系が多いので、各APIは次の方針を持つ。
- `timeoutMs`（既定）を持つ：省略時でも安全に終了できる
- `pollIntervalMs` を持つ（ポーリング型の場合）
- バッチ処理は `concurrency` を持つ（上限を設ける）

---

## 2. データモデル（レスポンス内構造）

### 2.1 TxConfirmation（1件の確認結果）
```json
{
  "txhash": "ABC...",
  "confirmed": true,
  "height": "123",
  "code": 0,
  "latencyMs": 1834,
  "firstSeenAt": "2026-01-23T12:00:00Z",
  "confirmedAt": "2026-01-23T12:00:01Z",
  "raw": {}
}
```

### 2.2 BatchSummary（バッチ集計）
```json
{
  "total": 100,
  "succeeded": 95,
  "failed": 5,
  "timeout": 0,
  "durationMs": 12000,
  "latencyMs": {
    "mean": 2100,
    "p50": 1900,
    "p95": 4200,
    "max": 9000
  },
  "errors": [
    { "code": "TX_FAILED", "count": 5 }
  ]
}
```

### 2.3 Snapshot（実験時点の状態記録）
```json
{
  "takenAt": "2026-01-23T12:00:00Z",
  "system": {
    "namespace": "cryptomeria",
    "pods": [],
    "services": []
  },
  "chains": [
    { "chainId": "mdsc", "latestHeight": "1234", "catchingUp": false }
  ],
  "notes": { "tag": "expA", "params": {} }
}
```

---

## 3. エンドポイント仕様（Utilities層）

## 3.1 POST `/utils/observe/tx-confirmation`（Tx確認待ち）
- **目的**  
  `txhash` がcommitされるまで待機し、結果と待機時間（latency）を返す。
- **何を提供するか**  
  - 1件の txhash に対する confirmed 여부
  - confirmationまでの時間（ms）
  - 最終的に取得できた txレスポンス（raw）
- **どんなことに使えるか**  
  - “確認時間（commit latency）” の測定
  - 実験クライアント側の再試行/待機ロジックを単純化
- **内部的に必要な情報**  
  - 第2層 `/chains/{chainId}/tx/{txhash}` をポーリングする仕組み
  - timeout / pollInterval の制御
  - 「まだ見つからない」と「失敗（code!=0）」を区別するルール

#### Request
```json
{
  "chainId": "mdsc",
  "txhash": "ABCDEF...",
  "timeoutMs": 60000,
  "pollIntervalMs": 500,
  "includeRaw": true
}
```

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "chainId": "mdsc",
    "result": {
      "txhash": "ABCDEF...",
      "confirmed": true,
      "height": "123",
      "code": 0,
      "latencyMs": 1834,
      "firstSeenAt": "2026-01-23T12:00:00Z",
      "confirmedAt": "2026-01-23T12:00:01Z",
      "raw": {}
    }
  }
}
```

#### エラー
- `404`：`CHAIN_NOT_FOUND`
- `408/504`：`TIMEOUT`（timeoutMsに達した）
- `422`：`INVALID_INPUT`（pollInterval範囲外など）

---

## 3.2 POST `/utils/observe/tx-latency`（複数Txの確認時間を統計化）
- **目的**  
  複数 `txhash` の confirmation をまとめて待ち、latency統計と成功率を返す。
- **何を提供するか**  
  - 各txの確認結果配列（必要なら）
  - 集計統計（平均/中央値/p95等）
- **どんなことに使えるか**  
  - 負荷試験の結果集計
  - 条件（fdsc台数、送信レート）の比較
- **内部的に必要な情報**  
  - `/utils/observe/tx-confirmation` 相当の並列実行
  - concurrency制限、タイムアウト、統計計算

#### Request
```json
{
  "chainId": "mdsc",
  "txhashes": ["A...", "B...", "C..."],
  "timeoutMs": 60000,
  "pollIntervalMs": 500,
  "concurrency": 10,
  "percentiles": [50, 90, 95, 99],
  "includeItems": true
}
```

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "chainId": "mdsc",
    "summary": {
      "total": 3,
      "succeeded": 3,
      "failed": 0,
      "timeout": 0,
      "durationMs": 5500,
      "latencyMs": { "mean": 2100, "p50": 1900, "p95": 4200, "max": 4200 },
      "errors": []
    },
    "items": [
      { "txhash": "A...", "confirmed": true, "code": 0, "latencyMs": 1800, "height": "10" },
      { "txhash": "B...", "confirmed": true, "code": 0, "latencyMs": 2200, "height": "11" },
      { "txhash": "C...", "confirmed": true, "code": 0, "latencyMs": 2300, "height": "11" }
    ]
  }
}
```

#### エラー
- `422`：`INVALID_INPUT`（concurrencyが範囲外など）
- `429`：`RATE_LIMITED`（サーバ側上限で拒否する設計の場合）

---

## 3.3 GET `/utils/metrics/blocktime`（複数チェーンのブロック時間統計をまとめる）
- **目的**  
  第2層の `/chains/{chainId}/blocktime` を複数chainIdに対して実行し、比較しやすい形でまとめて返す。
- **何を提供するか**  
  - chainIdごとのブロック時間統計
  - 取得に使ったwindow/範囲情報
- **どんなことに使えるか**  
  - mdsc vs fdsc-0.. の比較
  - スケール前後比較（同windowで並べる）
- **内部的に必要な情報**  
  - `/chains` でchainId列挙（またはリクエストで指定）
  - `/chains/{chainId}/blocktime` 呼び出し
  - concurrency制御

#### Query Parameters（任意）
- `chainIds`：カンマ区切り（省略時は全チェーン）
- `window`：既定 100
- `percentiles`：例 `50,95`
- `concurrency`：既定 5

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "window": 100,
    "unit": "seconds",
    "items": [
      {
        "chainId": "mdsc",
        "stats": { "mean": 1.02, "p50": 1.01, "p95": 1.18, "min": 0.88, "max": 1.40 }
      },
      {
        "chainId": "fdsc-0",
        "stats": { "mean": 1.10, "p50": 1.09, "p95": 1.35, "min": 0.90, "max": 1.80 }
      }
    ]
  }
}
```

---

## 3.4 GET `/utils/metrics/throughput`（TPS近似）
- **目的**  
  指定windowのブロック群から tx数と時間差分を集計し、TPS（近似）を返す。
- **何を提供するか**  
  - window内の総tx数
  - 経過秒数
  - TPS（tx/sec）の近似値
- **どんなことに使えるか**  
  - 負荷試験の指標（スケール時の改善/悪化）
  - 実験記録としての定量値
- **内部的に必要な情報**  
  - `/chains/{chainId}/blocks/{height}/txs` で各ブロックのtx数取得
  - `/chains/{chainId}/blocks/{height}` で時刻取得（またはblock headerから）
  - window分のループ（負荷を考えキャッシュ/間引きも検討）

#### Query Parameters
- `chainId`：必須
- `window`：既定 200
- `concurrency`：既定 5（ブロック取得の並列数）
- `mode`：`exact|estimate`（既定 `estimate`）
  - `estimate`：txsの実体取得を避け、txCountだけを取れる方法があればそれを使う（上流依存）
  - `exact`：block内txを実際に数える（重いが正確）

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "chainId": "mdsc",
    "window": 200,
    "fromHeight": "1000",
    "toHeight": "1199",
    "durationSeconds": 210.5,
    "txCount": 4200,
    "tps": 19.95,
    "notes": { "mode": "estimate" }
  }
}
```

---

## 3.5 POST `/utils/load/broadcast-batch`（Tx投入バッチ）
- **目的**  
  署名済み `txBytes` 配列をまとめてbroadcastし、結果を集計して返す。
- **何を提供するか**  
  - 各Txのbroadcast結果（txhash/code等）
  - 成功率、所要時間、エラー分類
- **どんなことに使えるか**  
  - 負荷試験の “投入部分” をBFFに寄せる
  - 実験コード側で並列制御や結果集計をしなくてよい
- **内部的に必要な情報**  
  - 第2層 `/chains/{chainId}/broadcast` の並列実行
  - concurrency/rate制御
  - エラー分類（上流エラーの正規化）

#### Request
```json
{
  "chainId": "mdsc",
  "txs": ["<base64>", "<base64>"],
  "broadcastMode": "sync",
  "concurrency": 20,
  "timeoutMs": 60000,
  "includeItems": true
}
```

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "chainId": "mdsc",
    "summary": {
      "total": 2,
      "succeeded": 2,
      "failed": 0,
      "timeout": 0,
      "durationMs": 1200,
      "errors": []
    },
    "items": [
      { "index": 0, "txhash": "AAA...", "code": 0, "rawLog": "" },
      { "index": 1, "txhash": "BBB...", "code": 0, "rawLog": "" }
    ]
  }
}
```

#### エラー
- `422`：`INVALID_INPUT`（txs空、concurrency範囲外等）
- `429`：`RATE_LIMITED`（サーバ上限）

---

## 3.6 POST `/utils/load/confirm-batch`（Tx確認バッチ）
- **目的**  
  `txhash` 配列の confirmation をまとめて待ち、結果と統計を返す。
- **何を提供するか**  
  - confirmed率、latency統計、未確認一覧
- **どんなことに使えるか**  
  - “投入→確認” を二段に分けた実験での後段処理
  - 大量txの確認を簡単にする
- **内部的に必要な情報**  
  - `/utils/observe/tx-confirmation` 相当の並列実行
  - concurrency制御・タイムアウト

#### Request
```json
{
  "chainId": "mdsc",
  "txhashes": ["AAA...", "BBB..."],
  "timeoutMs": 60000,
  "pollIntervalMs": 500,
  "concurrency": 20,
  "percentiles": [50, 95],
  "includeItems": true
}
```

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "chainId": "mdsc",
    "summary": {
      "total": 2,
      "succeeded": 2,
      "failed": 0,
      "timeout": 0,
      "durationMs": 4200,
      "latencyMs": { "mean": 2100, "p50": 2100, "p95": 2100, "max": 2100 },
      "errors": []
    },
    "items": [
      { "txhash": "AAA...", "confirmed": true, "code": 0, "latencyMs": 2000, "height": "120" },
      { "txhash": "BBB...", "confirmed": true, "code": 0, "latencyMs": 2200, "height": "121" }
    ]
  }
}
```

---

## 3.7 GET `/utils/k8s/resource-snapshot`（実験時点の状態スナップショット）
- **目的**  
  実験時点のシステム状態（Pod/Service/ポート、可能ならチェーン状態）を1つのJSONにまとめて返す。  
  「後から再現できる」形で、実験ログに添付する用途を想定する。
- **何を提供するか**  
  - 第1層 `GET /system/status` と同等、またはそれを内包したスナップショット
  - 追加で、チェーンの最新heightやcatchingUp等（取得できる範囲）
- **どんなことに使えるか**  
  - 実験ログに添付（実験条件の記録）
  - 異常時の切り分け情報として保存
- **内部的に必要な情報**  
  - 第1層 `system/status` 相当の収集
  - 第2層 `chains/*/status` の収集（任意）
  - 整形と安定化（順序、必要フィールド）

#### Query Parameters（任意）
- `includeChains`：`true|false`（既定 true）
- `includePorts`：`true|false`（既定 true）
- `tag`：任意の識別子（例：`expA`）

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "takenAt": "2026-01-23T12:00:00Z",
    "system": {
      "namespace": "cryptomeria",
      "pods": [],
      "services": []
    },
    "chains": [
      { "chainId": "mdsc", "latestHeight": "1234", "catchingUp": false }
    ],
    "notes": { "tag": "expA", "params": {} }
  }
}
```

---

## 3.8 POST `/utils/experiments/run`（任意：実験シナリオ実行）
> 将来的に、卒研の実験手順を “ボタン1つ/コマンド1つ” で再実行可能にするための拡張。  
> v1では「枠」だけ決め、具体シナリオは必要になった時に追加する運用がよい。

- **目的**  
  事前定義した “実験シナリオ” を実行し、結果（統計・ログ・スナップショット）を返す。
- **何を提供するか**  
  - broadcast-batch → confirm-batch → metrics → snapshot の一連実行
  - 実行結果の統一フォーマット
- **どんなことに使えるか**  
  - 実験手順の固定化（手順ミス排除）
  - 同条件での繰り返し比較
- **内部的に必要な情報**  
  - シナリオ定義（JSON/YAMLなど）
  - （推奨）非同期ジョブ化（長時間になりやすい）
  - 各utils APIの合成呼び出し

#### Request（例）
```json
{
  "name": "loadtest_basic",
  "params": {
    "chainId": "mdsc",
    "count": 1000,
    "concurrency": 50
  }
}
```

#### Response（例：同期版）
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "name": "loadtest_basic",
    "startedAt": "2026-01-23T12:00:00Z",
    "finishedAt": "2026-01-23T12:05:00Z",
    "result": {
      "broadcast": { "summary": { "total": 1000, "succeeded": 990, "failed": 10, "timeout": 0, "durationMs": 60000, "errors": [] } },
      "confirm": { "summary": { "total": 990, "succeeded": 980, "failed": 10, "timeout": 0, "durationMs": 120000, "errors": [] } },
      "metrics": { "tps": 20.1 },
      "snapshot": { "takenAt": "2026-01-23T12:05:00Z", "system": {}, "chains": [] }
    }
  }
}
```

---

## 4. 実装上の注意（Utilities層の落とし穴）
- **重い処理を作りやすい**  
  - throughput計算で大量ブロック取得をすると上流とBFFに負荷  
  → window上限、キャッシュ、estimateモードを用意する。
- **並列処理の暴走**  
  - broadcast/confirmは concurrency 上限必須  
  → BFF側で最大値を固定し、リクエスト値はclampする。
- **タイムアウトと“未確認”の扱い**  
  - timeoutは “失敗” ではなく “未確認” として別カウントするのが実験に有用。
- **結果の再現性**  
  - snapshotを添付することで、後から “その時のシステム状態” を説明できる。

---
