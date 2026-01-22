# API第一層仕様書（System / K8s Layer）

- 対象: Cryptomeria-BFF v1
- 版: 1.0.0
- 最終更新: 2026-01-23
- この層の目的: **Cryptomeria-core が Helm により既にインストール済みであることを前提**に、BFF 経由で
  - システムの稼働状態を **kubectl無しで把握**できる
  - relayer 初期化・接続・起動などの **start-system 相当**を API で実行できる
  - 実行は **非同期ジョブ**として追跡できる（ジョブは揮発性）

> 重要: v1では **helm install/uninstall/deploy/clean はBFFの範疇外**（手動運用）。  
> BFFは「インストール済みのシステムに対して start/connect を行う」ことに集中する。

---

## 1. 前提・制約

### 1.1 配置
- **BFF はクラスタ外で動作**する。
- BFF は Kubernetes API へアクセスできる `kubeconfig`（もしくは同等の認証情報）を保持する。
- Cryptomeria-core は Kubernetes 上の特定 namespace（例: `cryptomeria`）にデプロイされている。

### 1.2 RBAC
- RBAC は Helm chart 側の `helm/cryptomeria/template/bff/rbac.yaml` で作成される想定。
- v1の第1層が必要とする主な権限（目安）:
  - `pods`: get/list/watch
  - `pods/log`: get
  - `pods/exec`: create
  - `services`: get/list/watch
  - `endpoints`: get/list/watch
  - `configmaps`: get/list/watch（提供する場合）
- ※ stop/resume/scale など “レプリカ変更” を行う API を v1 に含める場合は、`deployments/statefulsets` の patch/update 等が追加で必要になる。

### 1.3 ジョブ永続化
- **ジョブはインメモリ管理**であり、BFF再起動時に全て消える。
- 再起動影響を最小化するため、各ジョブは **force=false のとき冪等判定（状態に基づく skip）**を行う。

---

## 2. 共通仕様

### 2.1 Base Path
- `/api/v1/system`

### 2.2 Content-Type
- Request/Response は基本 `application/json; charset=utf-8`

### 2.3 認証
- v1ではアプリ層の認証は必須としない（研究/閉域前提）。
- 代替として「到達制御（例: 研究室LAN/VPN/localhost限定）」を推奨。
- 将来拡張: `Authorization: Bearer <token>` を導入しても互換性を壊さない設計とする。

### 2.4 時刻
- すべて ISO 8601（UTC推奨）例: `2026-01-23T09:00:00Z`

### 2.5 エラー形式（共通）
```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "selector is invalid",
    "details": { "field": "selector" }
  }
}
```

代表 code:
- `INVALID_ARGUMENT` (400)
- `NOT_FOUND` (404)
- `CONFLICT` (409) : 排他/多重実行
- `K8S_UNAVAILABLE` (503)
- `INTERNAL` (500)

---

## 3. リソース探索ルール（最小仕様）

> v1では探索ルールを「最小限」で定め、問題が出た場合に調整する。

### 3.1 Namespace
- デフォルト namespace: `cryptomeria`
- 変更したい場合は BFF の環境変数（例: `K8S_NAMESPACE`）で指定する。

### 3.2 Relayer Pod の同定（推奨順）
1. label selector（推奨）: `app.kubernetes.io/component=relayer`  
2. 見つからない場合のフォールバック:
   - Pod 名 prefix に `relayer` を含むものを候補とし、**Ready** のものを優先する

---

## 4. データモデル（第1層）

### 4.1 SystemStatus（要約）
```json
{
  "namespace": "cryptomeria",
  "observedAt": "2026-01-23T09:00:00Z",
  "summary": {
    "podsTotal": 12,
    "podsReady": 12,
    "podsNotReady": 0,
    "restartsTotal": 0
  },
  "relayer": {
    "podName": "cryptomeria-relayer-xxxxx",
    "ready": true,
    "rlyRunning": true
  },
  "chains": [
    {
      "chainId": "gwc",
      "podName": "cryptomeria-gwc-0",
      "ready": true
    }
  ],
  "notes": [
    "helm operations are out of scope in v1"
  ]
}
```

### 4.2 Topology（接続に必要な情報の集合）
```json
{
  "namespace": "cryptomeria",
  "observedAt": "2026-01-23T09:00:00Z",
  "chains": [
    {
      "chainId": "gwc",
      "pod": { "name": "cryptomeria-gwc-0", "ip": "10.0.0.10", "ready": true },
      "service": { "name": "cryptomeria-gwc", "type": "NodePort" },
      "ports": [
        { "name": "rpc", "port": 26657, "nodePort": 30001 },
        { "name": "rest", "port": 1317, "nodePort": 30002 }
      ]
    }
  ],
  "relayer": {
    "pod": { "name": "cryptomeria-relayer-xxxxx", "ready": true }
  }
}
```

---

## 5. エンドポイント一覧

### 5.1 状態・探索（同期）
- `GET /status`
- `GET /preflight`
- `GET /topology`
- `GET /k8s/pods`
- `GET /k8s/services`
- `GET /k8s/endpoints`
- `GET /k8s/configmaps`（任意: 提供する場合）
- `GET /k8s/logs`

### 5.2 システム操作（非同期ジョブ）
- `POST /start`
- `POST /connect`
- `POST /relayer/restart`（任意: v1で入れる場合）

### 5.3 ジョブ（Systemスコープ）
- `GET /jobs`
- `GET /jobs/{jobId}`
- `GET /jobs/{jobId}/logs`
- `POST /jobs/{jobId}/cancel`

> ジョブモデルの共通仕様は **APIJOB仕様書.md** に準拠する。  
> 本仕様書では System スコープの job type / step を規定する。

---

## 6. 各API仕様（第1層）

## 6.1 GET /status
システム稼働状況の要約を返す。

### Query
- `verbose` (optional, default=false): trueで chains/services の詳細を増やす

### Response
- 200: `SystemStatus`

### 例
```http
GET /api/v1/system/status HTTP/1.1
```

---

## 6.2 GET /preflight
`/start` 実行前に必要な前提が揃っているか確認する。  
（Helm操作はしないが、**インストール済み前提で start できるか**を説明付きで返す）

### Response (200)
```json
{
  "namespace": "cryptomeria",
  "observedAt": "2026-01-23T09:00:00Z",
  "checks": [
    { "name": "namespaceExists", "ok": true },
    { "name": "relayerPodFound", "ok": true, "details": { "podName": "cryptomeria-relayer-xxxxx" } },
    { "name": "podsExecAllowed", "ok": true },
    { "name": "chainPodsReady", "ok": true, "details": { "ready": 12, "total": 12 } }
  ],
  "overallOk": true
}
```

### エラー
- 503 `K8S_UNAVAILABLE`: K8s API に到達できない等

---

## 6.3 GET /topology
チェーンPod/Service/Portの対応をまとめて返す（実験/接続/デバッグ向け）。

### Response
- 200: `Topology`

---

## 6.4 GET /k8s/pods
cryptomeria namespace 内の Pod を一覧で返す。

### Query
- `selector` (optional): label selector（例: `app.kubernetes.io/component=relayer`）
- `name` (optional): 部分一致フィルタ
- `includeContainers` (optional, default=false): container 状態も含む

### Response (200)
```json
{
  "items": [
    {
      "name": "cryptomeria-gwc-0",
      "namespace": "cryptomeria",
      "labels": { "app.kubernetes.io/component": "chain" },
      "phase": "Running",
      "ready": true,
      "restarts": 0,
      "podIP": "10.0.0.10"
    }
  ]
}
```

---

## 6.5 GET /k8s/services
Service を一覧で返す。

### Query
- `selector` (optional)
- `name` (optional)

### Response (200)
```json
{
  "items": [
    {
      "name": "cryptomeria-gwc",
      "type": "NodePort",
      "clusterIP": "10.96.0.1",
      "ports": [
        { "name": "rpc", "port": 26657, "nodePort": 30001, "protocol": "TCP" }
      ],
      "selector": { "app.kubernetes.io/instance": "gwc" }
    }
  ]
}
```

---

## 6.6 GET /k8s/endpoints
Endpoints を一覧で返す（Service 解決補助）。

### Query
- `name` (optional)
- `selector` (optional)

---

## 6.7 GET /k8s/configmaps（任意）
ConfigMap を一覧で返す（v1では **データ本体は返さずキー一覧が基本**）。

### Query
- `name` (optional)
- `includeData` (optional, default=false): true の場合のみ data を返す（研究用途でも慎重推奨）

### Response (200)
```json
{
  "items": [
    {
      "name": "cryptomeria-some-config",
      "keys": ["config.toml", "app.toml"]
    }
  ]
}
```

---

## 6.8 GET /k8s/logs
Podログを返す（デバッグ向け）。

### Query
- `podName` (required)
- `container` (optional)
- `tailLines` (optional, default=200)
- `sinceSeconds` (optional)
- `timestamps` (optional, default=false)

### Response
- 200: `text/plain`（ログ文字列）
- 404: Podが存在しない

---

# 7. システム操作（ジョブ）

## 7.1 POST /start
インストール済みの cryptomeria システムに対し、**start-system 相当**を実行する。

### 概要
- relayer pod 内で以下の順に実施（force=false時は冪等判定で skip）:
  1. `initRelayer`: rly config / chains / keys の整備
  2. `connectAll`: チェーン間の接続 + 必要な登録（例: GWC への storage 登録）
  3. `startRelayer`: `rly start` の起動（既に稼働なら skip または再起動）
  4. `waitReady`: 必要条件が整うまで待機（任意: short timeout）

### Request
```json
{
  "force": false,
  "timeoutMs": 600000,
  "dryRun": false
}
```

- `force`:
  - false: 状態を見て **実行済みは skip**（推奨）
  - true: 冪等判定を無視して再実行を試みる（危険。研究用途でも注意）
- `timeoutMs`: 全体タイムアウト（推奨 5〜15分）
- `dryRun`: true の場合、実行計画（何をskipし何を実行するか）を返す（ジョブは作らない）

### Response
- 202: Job 作成（`jobId` を返す）
- 200: dryRun の結果（`plan` を返す）
- 409: 同種の system 操作ジョブが既に running

#### 202例
```json
{
  "jobId": "job_01HT....",
  "type": "system.start",
  "status": "queued",
  "createdAt": "2026-01-23T09:00:00Z"
}
```

#### dryRun(200)例
```json
{
  "plan": [
    { "step": "initRelayer", "action": "skip", "reason": "config/chains/keys already exist" },
    { "step": "connectAll", "action": "run" },
    { "step": "startRelayer", "action": "run" },
    { "step": "waitReady", "action": "run" }
  ]
}
```

---

## 7.2 POST /connect
接続処理のみを実行（connect-all 相当）。`/start` から切り出して再実行しやすくする。

### Request
```json
{
  "force": false,
  "timeoutMs": 600000,
  "target": "all"
}
```
- `target`: `"all"` または `"chain:<chainId>"`（例: `"chain:fdsc-0"`）

### Response
- 202: Job 作成（type=`system.connect`）

---

## 7.3 POST /relayer/restart（任意）
relayer の `rly start` を再起動する（デバッグ用）。

### Request
```json
{ "timeoutMs": 120000 }
```

### Response
- 202: Job 作成（type=`system.relayer.restart`）

---

# 8. Systemジョブ type と step 定義（APIJOB仕様書への上書き）

本層では、以下の job type を定義する。

## 8.1 job type 一覧
- `system.start`
- `system.connect`
- `system.relayer.restart`（任意）

## 8.2 step 定義（推奨）
### system.start steps
1. `discover`: namespace/pods/relayer 同定
2. `initRelayer`: rly config/chains/keys
3. `connectAll`: IBC link + 登録
4. `startRelayer`: rly start 起動確認
5. `waitReady`: 必要条件待機（任意）

### system.connect steps
1. `discover`
2. `connectAll`（または target に応じて connectChain）

### system.relayer.restart steps
1. `discover`
2. `stopRelayer`（存在する場合）
3. `startRelayer`

## 8.3 冪等判定（force=false のとき）
- discover: 常に実行
- initRelayer:
  - rly config が存在し、必要 chain 定義が揃い、keys が揃っていれば skip
- connectAll:
  - 既に必要 channel/connection が存在していれば対象ペアは skip
  - 既に登録済みなら skip
- startRelayer:
  - `rly` プロセスが稼働中なら skip（または restart ジョブで再起動）
- waitReady:
  - ready 条件が満たされていれば skip

---

# 9. 排他・実行上限
- v1では system 操作ジョブ（`system.*`）は **同時に1つまで**（running があれば 409）。
- 状態系（GET）は常に実行可能。

---

# 10. 非対応（v1スコープ外）
- Helm の install/uninstall/upgrade/clean を BFF から実行する機能
- 画像ビルド、レジストリ push、minikube load 等のビルド/配布機能
- ジョブ永続化（DB/永続ストア）

---

# 11. 変更履歴
- 1.0.0: v1 初版（helm操作を範疇外、ジョブは揮発、/start を中核に定義）
