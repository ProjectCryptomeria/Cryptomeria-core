# 第1層 API仕様書：System / K8s Layer（cryptomeriaシステム運用API）

- 対象: Cryptomeria-BFF v1
- 対象層: 第1層（System / K8s）
- BasePath: `/api/v1`
- Prefix: `/system`
- 版: v1（Merged）

> 本仕様書は **第1層（System/K8s）** のみを対象とする。  
> 目的は、`kubectl` / `just` / shell に依存していた **cryptomeria-core のk8s運用**（Pod/Service確認、relayer exec による初期化・接続、スケール、停止・復帰、撤去など）を **BFFのHTTP APIとして提供**すること。  
> 重要: 本仕様書は「運用APIの提供」を扱い、**認証・権限・ADMIN等の概念は本要件から撤廃し、仕様書でも扱わない**。

---

## 1. 前提・制約

### 1.1 前提（インストール済み）
- この層の目的: **Cryptomeria-core が Helm により既にインストール済みであることを前提**に、BFF 経由で
  - システムの稼働状態を **kubectl無しで把握**できる
  - relayer 初期化・接続・起動などの **start-system 相当**を API で実行できる
  - 実行は **非同期ジョブ**として追跡できる（ジョブは揮発性）

> 重要: v1では **helm install/uninstall/deploy/clean はBFFの範疇外**（手動運用）。  
> BFFは「インストール済みのシステムに対して start/connect を行う」ことに集中する。

### 1.2 配置
- **BFF はクラスタ外で動作**する。
- BFF は Kubernetes API へアクセスできる `kubeconfig`（もしくは同等の認証情報）を保持する。
- Cryptomeria-core は Kubernetes 上の特定 namespace（例: `cryptomeria`）にデプロイされている。

### 1.3 ジョブ永続化
- **ジョブはインメモリ管理**であり、BFF再起動時に全て消える。
- 再起動影響を最小化するため、各ジョブは **force=false のとき冪等判定（状態に基づく skip）**を行う。

---

## 2. 共通仕様（System層）

### 2.1 Base Path
- `/api/v1/system`

（本仕様書冒頭の BasePath + Prefix 表記に従うと、実体は上記に一致する。）

### 2.2 Content-Type
- Request/Response は基本 `application/json; charset=utf-8`
- ログ取得：`text/plain; charset=utf-8`（デフォルト）または `application/x-ndjson`（jsonl）

### 2.3 時刻
- すべて ISO 8601（UTC推奨）例: `2026-01-23T09:00:00Z`

### 2.4 成功/エラーの基本形

System層は「状態照会系」と「操作系（非同期ジョブ）」で返却の形が少し異なる。

#### (A) 状態照会系（例：`GET /system/status`）
- `200 OK`
- レスポンスは `{ "ok": true, "data": ... }` を基本とする

#### (B) 操作系（例：`POST /system/start`）
- `202 Accepted`
- **jobIdを即時返し、処理はバックグラウンドで実行**する
- job追跡は `/system/jobs/*` で行う

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

加えて、System層では以下のHTTPが登場し得る：
- `422 Unprocessable Entity`：値域/enum不正、steps指定が不正
- `504 Gateway Timeout`：外部依存（k8s/helm/exec）の待機が上限に達した（同期処理を採る場合）

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

### 3.3 start-system で必要となる内部的前提（例）
- 対象Namespace（既定：`cryptomeria`）
- relayer Pod の同定規則（例：`app.kubernetes.io/name=cryptomeria`、`app.kubernetes.io/component=relayer`）
- exec 実行のための k8s client（pods/exec）
- 状態監視（pods/log, chain REST/RPC疎通 など）

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

## 5. ジョブモデル（System層の非同期実行）

System層の「重い操作」は、BFF内部で **ジョブ**として管理する。

### 5.1 Job状態（status）
- `queued`：受理済み、まだ実行開始していない
- `running`：実行中
- `succeeded`：成功
- `failed`：失敗
- `canceled`：キャンセル要求により中断（ベストエフォート）

### 5.2 Job共通フィールド
- `jobId`：一意ID（例：`job_20260123_abcdef`）
- `type`：ジョブ種別（例：`system.start`）
- `createdAt` / `startedAt` / `finishedAt`：ISO8601
- `steps[]`：実行ステップ配列（ステップ別の状態とログ）
- `error`：失敗時の原因（機械可読なcode + message + details）

### 5.3 Jobログ
- BFFが収集する「ジョブログ」を返す（relayer pod内コマンドのstdout/stderrなど）
- relayerそのもののログ（`kubectl logs relayer`相当）とは区別する  
  - ジョブログ：BFFが実行した各ステップの “手順ログ”
  - relayerログ：relayerプロセスの “稼働ログ”

---

## 6. エンドポイント一覧（System層）

### 6.1 状態・探索（同期）
- `GET /status`
- `GET /preflight`
- `GET /topology`
- `GET /ports`
- `GET /k8s/pods`
- `GET /k8s/services`
- `GET /k8s/endpoints`
- `GET /k8s/configmaps`（任意: 提供する場合）
- `GET /k8s/logs`

### 6.2 システム操作（非同期ジョブ）
- `POST /start`
- `POST /connect`
- `POST /relayer/restart`（任意: v1で入れる場合）

### 6.3 ジョブ（Systemスコープ）
- `GET /jobs`
- `GET /jobs/{jobId}`
- `GET /jobs/{jobId}/logs`
- `POST /jobs/{jobId}/cancel`

> 本仕様書では System スコープの job type / step を規定する。

---

## 7. 各API仕様（第1層）

### 7.1 GET `/status`
システム稼働状況の要約を返す。

#### Query
- `verbose` (optional, default=false): trueで chains/services の詳細を増やす

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
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
      "rlyRunning": true,
      "hint": "use /system/jobs/* for workflow logs"
    },
    "chains": [
      { "chainId": "gwc", "podName": "cryptomeria-gwc-0", "ready": true }
    ],
    "notes": [
      "helm operations are out of scope in v1"
    ]
  }
}
```

---

### 7.2 GET `/preflight`
`/start` 実行前に必要な前提が揃っているか確認する。  
（Helm操作はしないが、**インストール済み前提で start できるか**を説明付きで返す）

#### Response (200)
```json
{
  "ok": true,
  "data": {
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
}
```

#### エラー
- 503 `K8S_UNAVAILABLE`: K8s API に到達できない等

---

### 7.3 GET `/topology`
チェーンPod/Service/Portの対応をまとめて返す（実験/接続/デバッグ向け）。

#### Response
- 200: `Topology` を `data` に格納して返す
```json
{
  "ok": true,
  "data": {
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
}
```

---

### 7.4 GET `/ports`（ポート一覧）
Serviceを読み、NodePort/ClusterIP と主要ポートを一覧化（チェーン接続先確認用）。

#### 目的
- cryptomeriaが公開している “接続先一覧（どのServiceのどのポートへ繋ぐか）” をAPIで返す。

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "namespace": "cryptomeria",
    "nodeHost": "192.168.49.2",
    "chains": [
      {
        "chainId": "mdsc",
        "external": {
          "rpc": "http://192.168.49.2:31057",
          "api": "http://192.168.49.2:30317",
          "grpc": "192.168.49.2:30090"
        },
        "internal": {
          "rpc": "http://cryptomeria-mdsc:26657",
          "api": "http://cryptomeria-mdsc:1317",
          "grpc": "cryptomeria-mdsc:9090"
        }
      }
    ]
  }
}
```

---

## 8. k8sリソース参照（System層）

### 8.1 GET `/k8s/pods`
cryptomeria namespace 内の Pod を一覧で返す。

#### Query
- `selector` (optional): label selector（例: `app.kubernetes.io/component=relayer`）
- `name` (optional): 部分一致フィルタ
- `includeContainers` (optional, default=false): container 状態も含む
- `component`（任意）例 `relayer|gwc|mdsc|fdsc`
- `instance`（任意）例 `fdsc-0`
- `phase`（任意）例 `Running`

#### Response (200)
```json
{
  "ok": true,
  "data": {
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
}
```

---

### 8.2 GET `/k8s/services`
Service を一覧で返す。

#### Query
- `selector` (optional)
- `name` (optional)

#### Response (200)
```json
{
  "ok": true,
  "data": {
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
}
```

---

### 8.3 GET `/k8s/endpoints`
Endpoints を一覧で返す（Service 解決補助）。

#### Query
- `name` (optional)
- `selector` (optional)

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "name": "cryptomeria-gwc",
        "subsets": [
          {
            "addresses": [{ "ip": "10.0.0.10" }],
            "ports": [{ "name": "rpc", "port": 26657, "protocol": "TCP" }]
          }
        ]
      }
    ]
  }
}
```

---

### 8.4 GET `/k8s/configmaps`（任意）
ConfigMap を一覧で返す（v1では **データ本体は返さずキー一覧が基本**）。

#### Query
- `name` (optional)
- `includeData` (optional, default=false): true の場合のみ data を返す（研究用途でも慎重推奨）

#### Response (200)
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "name": "cryptomeria-some-config",
        "keys": ["config.toml", "app.toml"]
      }
    ]
  }
}
```

---

### 8.5 GET `/k8s/logs`
Podログを返す（デバッグ向け）。

#### Query
- `podName` (required)
- `container` (optional)
- `tailLines` (optional, default=200)
- `sinceSeconds` (optional)
- `timestamps` (optional, default=false)

#### Response
- 200: `text/plain`（ログ文字列）
- 404: Podが存在しない

---

## 9. システム操作（ジョブ）

### 9.1 POST `/start`
インストール済みの cryptomeria システムに対し、**start-system 相当**を実行する。

#### 概要
- relayer pod 内で以下の順に実施（force=false時は冪等判定で skip）:
  1. `initRelayer`: rly config / chains / keys の整備
  2. `connectAll`: チェーン間の接続 + 必要な登録（例: GWC への storage 登録）
  3. `startRelayer`: `rly start` の起動（既に稼働なら skip または再起動）
  4. `waitReady`: 必要条件が整うまで待機（任意: short timeout）

#### Request
（省略可：全て既定値で実行できる前提）
```json
{
  "namespace": "cryptomeria",
  "timeoutSeconds": 1800,
  "steps": ["initRelayer", "connectAll", "startRelayer", "waitIbcReady"],
  "force": false
}
```

- `namespace`：省略時 `cryptomeria`
- `timeoutSeconds`：全体タイムアウト（省略時 1800）
- `steps`：実行ステップを限定したい場合（省略時は全実行）
- `force`：冪等チェックを無視して強制実行（基本は false 推奨）

#### Stepsの定義（推奨）
- `initRelayer`：relayer設定・chain定義・keys準備（coreの `init-relayer.sh` 相当）
- `connectAll`：全chain instanceの IBC link + GWCへの storage登録（coreの `connect-all.sh` 相当）
- `startRelayer`：relayer開始（coreの `start-relayer.sh` 相当）
- `waitIbcReady`：IBCが実験可能状態になったことを確認（例：channel/connection確認、必要なエンドポイント疎通）

> `force=false` の場合、各ステップは **冪等**に振る舞うのが望ましい：  
> 例）既にchains登録済みならskip、既にlink済みならskip、relayer稼働中なら再起動/skipを選ぶ等。

#### Response
- `202 Accepted`
```json
{
  "jobId": "job_20260123_abcdef",
  "type": "system.start",
  "status": "queued",
  "createdAt": "2026-01-23T12:34:56Z",
  "links": {
    "self": "/api/v1/system/jobs/job_20260123_abcdef",
    "logs": "/api/v1/system/jobs/job_20260123_abcdef/logs"
  }
}
```

#### エラー（例）
- `409 Conflict`：同種ジョブが既に running（排他制御している場合）
- `422`：steps が不正、timeoutSeconds が範囲外など
- `500`：k8s接続不可、内部例外

---

### 9.2 POST `/connect`
接続処理のみを実行（connect-all 相当）。`/start` から切り出して再実行しやすくする。

#### Request
```json
{
  "force": false,
  "timeoutMs": 600000,
  "target": "all"
}
```

- `target`: `"all"` または `"chain:<chainId>"`（例: `"chain:fdsc-0"`）

#### Response
- `202 Accepted`
```json
{
  "jobId": "job_20260123_bcdefa",
  "type": "system.connect",
  "status": "queued",
  "createdAt": "2026-01-23T12:34:56Z"
}
```

---

### 9.3 POST `/relayer/restart`（任意）
relayer の `rly start` を再起動する（デバッグ用）。

#### Request
```json
{ "timeoutMs": 120000 }
```

#### Response
- `202 Accepted`（type=`system.relayer.restart`）

---

## 10. ジョブAPI（Systemスコープ）

### 10.1 GET `/jobs`（ジョブ一覧）
systemジョブ一覧を取得する（UI/CLIでの追跡用）。

#### Query Parameters（任意）
- `type`：例 `system.start`
- `status`：`queued|running|succeeded|failed|canceled`
- `limit`：既定 20
- `since`：ISO8601（これ以降）

#### Response
- `200 OK`
```json
{
  "items": [
    {
      "jobId": "job_20260123_abcdef",
      "type": "system.start",
      "status": "running",
      "createdAt": "2026-01-23T12:34:56Z",
      "startedAt": "2026-01-23T12:35:10Z",
      "finishedAt": null
    }
  ]
}
```

---

### 10.2 GET `/jobs/{jobId}`（ジョブ詳細）
ジョブの詳細（進捗・ステップ・エラー）を取得する。

#### Response（例）
- `200 OK`
```json
{
  "jobId": "job_20260123_abcdef",
  "type": "system.start",
  "status": "running",
  "createdAt": "2026-01-23T12:34:56Z",
  "startedAt": "2026-01-23T12:35:10Z",
  "finishedAt": null,
  "progress": {
    "currentStep": "connectAll",
    "completedSteps": 1,
    "totalSteps": 4
  },
  "steps": [
    {
      "name": "initRelayer",
      "status": "succeeded",
      "startedAt": "2026-01-23T12:35:10Z",
      "finishedAt": "2026-01-23T12:36:02Z",
      "message": "relayer config/chains/keys ready"
    },
    {
      "name": "connectAll",
      "status": "running",
      "startedAt": "2026-01-23T12:36:03Z",
      "finishedAt": null,
      "message": "linking mdsc<->fdsc-0 ..."
    },
    {
      "name": "startRelayer",
      "status": "queued",
      "startedAt": null,
      "finishedAt": null
    },
    {
      "name": "waitIbcReady",
      "status": "queued",
      "startedAt": null,
      "finishedAt": null
    }
  ],
  "result": null,
  "error": null,
  "links": {
    "logs": "/api/v1/system/jobs/job_20260123_abcdef/logs"
  }
}
```

#### エラー
- `404 Not Found`：jobIdが存在しない

---

### 10.3 GET `/jobs/{jobId}/logs`（ジョブログ取得）
ジョブのログを取得する（原因切り分け・進捗確認）。

#### Query Parameters（任意）
- `tail`：末尾N行（既定 200）
- `since`：ISO8601（これ以降）
- `format`：`text|jsonl`（既定 text）
- `follow`：`true|false`（SSE等を使う場合）

#### Response（例：text）
- `200 OK`
- `Content-Type: text/plain; charset=utf-8`
```
[12:35:10Z] step=initRelayer cmd="rly config init" ok
[12:36:03Z] step=connectAll cmd="rly tx link ..." running
...
```

---

### 10.4 POST `/jobs/{jobId}/cancel`（ジョブ中断）
実行中ジョブを中断する（ベストエフォート）。

#### Response
- `200 OK`
```json
{
  "jobId": "job_20260123_abcdef",
  "status": "canceled",
  "message": "cancel requested"
}
```

#### 注意
- cancelは「ロールバック」ではない  
  途中まで作成されたIBC設定等は残る可能性がある（冪等チェックで再実行しやすくする方針推奨）

---

## 11. Systemジョブ type と step 定義（System層の規定）

### 11.1 job type 一覧
- `system.start`
- `system.connect`
- `system.relayer.restart`（任意）

### 11.2 step 定義（推奨）

#### system.start steps
1. `discover`: namespace/pods/relayer 同定
2. `initRelayer`: rly config/chains/keys
3. `connectAll`: IBC link + 登録
4. `startRelayer`: rly start 起動確認
5. `waitReady`: 必要条件待機（任意）

#### system.connect steps
1. `discover`
2. `connectAll`（または target に応じて connectChain）

#### system.relayer.restart steps
1. `discover`
2. `stopRelayer`（存在する場合）
3. `startRelayer`

### 11.3 冪等判定（force=false のとき）
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

## 12. 排他・実行上限
- v1では system 操作ジョブ（`system.*`）は **同時に1つまで**（running があれば 409）。
- 状態系（GET）は常に実行可能。

---

## 13. 非対応（v1スコープ外）
- Helm の install/uninstall/upgrade/clean を BFF から実行する機能
- 画像ビルド、レジストリ push、minikube load 等のビルド/配布機能
- ジョブ永続化（DB/永続ストア）

---

## 14. （参考）第1層の拡張候補（掲載のみ・次版で深掘り可能）
> ここは「第1層」の範囲だが、今回の要求は “まず第一層仕様書を出す” なので、エンドポイントは掲載しつつ **詳細は次版で深掘り可能**。

### 14.1 POST `/install`（ジョブ推奨）
- 目的：helmでcryptomeriaを導入する（`just deploy`相当）
- 何を提供するか：helm install、待機、結果をジョブで追跡
- 内部的に必要な情報：namespace/release/chartPath/values、helm実行手段

### 14.2 POST `/uninstall`（ジョブ推奨）
- 目的：helm uninstall +（任意）PVC等削除
- 何を提供するか：撤去とクリーンアップ
- 内部的に必要な情報：削除対象をcryptomeriaに限定する規則

### 14.3 POST `/scale/fdsc`（ジョブ推奨）
- 目的：fdsc台数変更＋接続再整備（`scale-fdsc.sh`相当）
- 何を提供するか：helm upgrade→待機→connect→relayer起動
- どんなことに使えるか：スケール実験

### 14.4 POST `/stop` / `/resume`
- 目的：replicas調整で停止/復帰（`just stop/resume`相当）
- 何を提供するか：対象リソースのスケール制御

---

## 15. 付録（参考）：RBAC（実装メモ）
> RBAC は Helm chart 側の `helm/cryptomeria/template/bff/rbac.yaml` で作成される想定。  
> v1の第1層が必要とする主な権限（目安）:
> - `pods`: get/list/watch
> - `pods/log`: get
> - `pods/exec`: create
> - `services`: get/list/watch
> - `endpoints`: get/list/watch
> - `configmaps`: get/list/watch（提供する場合）
> - ※ stop/resume/scale など “レプリカ変更” を行う API を v1 に含める場合は、`deployments/statefulsets` の patch/update 等が追加で必要になる。

---

## 16. 変更履歴
- 1.0.0: v1 初版（helm操作を範疇外、ジョブは揮発、/start を中核に定義）
- v1（Merged）: 旧仕様と新仕様を統合し、/ports・ジョブモデル詳細・/jobs/* の詳細例を追加（本文の記述を踏襲）
