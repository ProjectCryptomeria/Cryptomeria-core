# APIJOB仕様書（共通ジョブ基盤仕様 / Cryptomeria-BFF v1）

- 対象: Cryptomeria-BFF v1
- 版: 1.0.0
- 最終更新: 2026-01-23
- 適用範囲:
  - 第一層（System/K8s Layer）: `/api/v1/system/jobs/*`
  - 第三層（Utilities Layer）: `/api/v1/utils/jobs/*`
- 目的:
  - 長時間・多段処理を **非同期ジョブ**として統一管理し、進捗・ログ・キャンセルを提供する
  - v1では **揮発（インメモリ）**で管理し、BFF再起動時にジョブはクリアされる

---

## 1. 基本方針

### 1.1 非同期ジョブの適用範囲
以下の性質を持つ処理はジョブ化する。
- 数秒以上かかり得る（K8s操作、複数API呼び出し、待機/ポーリング、バッチ処理）
- 複数ステップで進捗がある
- 失敗時にログが必要
- キャンセル（best-effort）したい

### 1.2 揮発性（v1）
- ジョブはインメモリに保持される。
- BFF再起動時に **ジョブ・ログ・進捗は全て消える**。
- ただし System層のジョブは冪等性（状態に基づく skip）により再起動影響を最小化する（各層仕様に従う）。

### 1.3 キャンセル
- キャンセルは best-effort。
- 進行中の外部処理（K8s exec、上流RPC呼び出し等）を “可能な範囲で停止” するが、ロールバックはしない。
- キャンセル成功時の最終状態は `canceled`。

### 1.4 排他・上限
- スコープごとに排他・上限を設ける。
  - System: 同時実行 1（`system.*` の running がある場合 409）
  - Utilities: 上限を設け、超過は 429（詳細は第3層仕様）
- 排他・上限の具体値は実装の環境変数で調整可能とする（ただし API の意味は不変）。

---

## 2. スコープとエンドポイント

### 2.1 スコープ
- `system` スコープ: `/api/v1/system/jobs`
- `utils` スコープ: `/api/v1/utils/jobs`

> 同一モデルを各スコープで提供する。  
> （スコープごとに job type は異なる）

### 2.2 共通エンドポイント
- `GET  /api/v1/{scope}/jobs`
- `GET  /api/v1/{scope}/jobs/{jobId}`
- `GET  /api/v1/{scope}/jobs/{jobId}/logs`
- `POST /api/v1/{scope}/jobs/{jobId}/cancel`

---

## 3. 状態モデル

### 3.1 JobStatus
- `queued` : 受付済みでまだ実行開始していない
- `running` : 実行中
- `succeeded` : 正常終了
- `failed` : 異常終了（エラーあり）
- `canceled` : キャンセルにより終了

### 3.2 StepStatus
- `pending` : 未開始
- `running` : 実行中
- `skipped` : 冪等判定などによりスキップ
- `succeeded` : 正常終了
- `failed` : 異常終了
- `canceled` : キャンセルにより終了（途中含む）

---

## 4. データモデル

### 4.1 Job（共通）
```json
{
  "jobId": "job_01HTXXXXXXX",
  "scope": "system",
  "type": "system.start",
  "status": "running",
  "createdAt": "2026-01-23T09:00:00Z",
  "startedAt": "2026-01-23T09:00:01Z",
  "finishedAt": null,
  "request": { "force": false, "timeoutMs": 600000 },
  "progress": { "currentStep": 2, "totalSteps": 5, "completedSteps": 1 },
  "steps": [
    {
      "name": "discover",
      "status": "succeeded",
      "startedAt": "2026-01-23T09:00:01Z",
      "finishedAt": "2026-01-23T09:00:02Z",
      "message": "relayer pod found: cryptomeria-relayer-xxxxx"
    },
    {
      "name": "initRelayer",
      "status": "running",
      "startedAt": "2026-01-23T09:00:02Z",
      "finishedAt": null,
      "message": "initializing relayer config/chains/keys"
    }
  ],
  "result": null,
  "error": null
}
```

#### フィールド定義
- `jobId` (string, required): ジョブ識別子（衝突しない形式。ULID等を推奨）
- `scope` (string, required): `system` または `utils`
- `type` (string, required): ジョブ種別（層仕様書で定義）
- `status` (JobStatus, required)
- `createdAt/startedAt/finishedAt` (ISO8601)
- `request` (object, optional): ジョブを作成したリクエストの主要パラメータ（機密は含めない）
- `progress` (object, optional)
- `steps` (array, required)
- `result` (object|null): 成功時の成果物
- `error` (object|null): 失敗時のエラー

### 4.2 Progress
```json
{
  "currentStep": 2,
  "totalSteps": 5,
  "completedSteps": 1
}
```

### 4.3 Step
```json
{
  "name": "connectAll",
  "status": "skipped",
  "startedAt": "2026-01-23T09:00:10Z",
  "finishedAt": "2026-01-23T09:00:10Z",
  "message": "already connected (channels exist)"
}
```

### 4.4 JobError
```json
{
  "code": "UPSTREAM_UNAVAILABLE",
  "message": "failed to exec into relayer pod",
  "details": { "podName": "cryptomeria-relayer-xxxxx" }
}
```

---

## 5. ログ仕様

### 5.1 ログの性質
- ジョブログは「BFFが実行した処理のログ」を指す。
- relayer/chain のアプリログとは別（それらは第1層 `/system/k8s/logs` で取得）。

### 5.2 ログ形式
- `GET /api/v1/{scope}/jobs/{jobId}/logs`
  - Response: `text/plain; charset=utf-8`（基本）
- ログは追記型（append-only）で、行単位で蓄積する。

### 5.3 ログに含めるべき情報（推奨）
- step の開始/終了
- 外部呼び出し（K8s exec / 上流RPC）の要約（機密除外）
- skip 判定の理由
- エラー時のスタック/原因（機密除外）

### 5.4 ログ上限（推奨）
- v1はインメモリのため、ログサイズに上限を設ける（例: 1ジョブあたり 5MB）。
- 上限超過時は古いログから削る（リングバッファ）か、末尾を打ち切る。

---

## 6. API仕様（共通）

## 6.1 GET /api/v1/{scope}/jobs
ジョブ一覧を返す（新しい順）。

### Query
- `status` (optional): `queued|running|succeeded|failed|canceled`
- `type` (optional): 例 `system.start`
- `limit` (optional, default=50, max=200)

### Response (200)
```json
{
  "items": [
    { "jobId": "job_01HT...", "type": "system.start", "status": "running", "createdAt": "2026-01-23T09:00:00Z" }
  ]
}
```

---

## 6.2 GET /api/v1/{scope}/jobs/{jobId}
ジョブの詳細（steps/result/error を含む）を返す。

### Response (200)
- `Job`（完全形）

### エラー
- 404 `NOT_FOUND`: jobId が存在しない（BFF再起動後など）

---

## 6.3 GET /api/v1/{scope}/jobs/{jobId}/logs
ジョブログを返す。

### Query
- `tailLines` (optional, default=200, max=5000)
- `sinceSeconds` (optional)

### Response (200)
- `text/plain`

### エラー
- 404 `NOT_FOUND`

---

## 6.4 POST /api/v1/{scope}/jobs/{jobId}/cancel
ジョブをキャンセルする（best-effort）。

### Response
- 200:
```json
{
  "jobId": "job_01HT...",
  "status": "canceled",
  "canceledAt": "2026-01-23T09:01:00Z"
}
```

### エラー
- 404 `NOT_FOUND`
- 409 `CONFLICT`: 既に `succeeded/failed/canceled` の場合（キャンセル不要）

---

## 7. ジョブ作成APIの共通規約（各層の操作API向け）

### 7.1 202 Accepted の返却形式（推奨）
ジョブを作成する API（例: `/system/start`, `/utils/load/broadcast-batch`）は以下を返す。

```json
{
  "jobId": "job_01HTXXXXXXX",
  "scope": "system",
  "type": "system.start",
  "status": "queued",
  "createdAt": "2026-01-23T09:00:00Z"
}
```

### 7.2 dryRun（任意）
System層など、冪等判定が重要な操作系では `dryRun=true` をサポートし、
- ジョブを作成せず
- 実行計画（skip/run）を返す
ことが望ましい。

---

## 8. タイムアウト仕様

### 8.1 ジョブ全体タイムアウト
- ジョブ作成APIの request に `timeoutMs` を持つ場合、ジョブ全体の期限とする。
- 期限超過時:
  - ジョブを `failed` とし
  - `error.code = TIMEOUT` を設定する

### 8.2 ポーリング系タイムアウト
- tx confirmation 等のポーリングは `timeoutMs` と `pollIntervalMs` を分ける。
- 期限超過時は “未確定” として failed にするか、result に `confirmed=false` を含めるかは各APIで定義する（v1は failed 推奨）。

---

## 9. キャンセルの実装規約（best-effort）

推奨実装:
- ジョブに `abortSignal`（類似概念）を持たせ、各ステップが定期的に中断確認する
- 外部呼び出し（HTTP/K8s exec）が中断可能なら中断する
- 中断不可の場合でも、以降のステップに進まない

キャンセル後の状態遷移:
- `running` → `canceled`
- `queued` → `canceled`

---

## 10. セキュリティ・機密情報の扱い

- `request` や `logs` に以下を含めない:
  - kubeconfig / token / secret / mnemonic / private key
  - 署名済みTxの生データ（必要なら “件数/サイズ” のみ）
- errors/details も同様に機密を出さない。

---

## 11. 変更履歴
- 1.0.0: v1 初版（system/utils共通ジョブモデル、揮発、ログ、キャンセル、排他/上限の枠組み）
