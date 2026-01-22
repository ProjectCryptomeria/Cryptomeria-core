# 第1層 API仕様書：System / K8s（cryptomeriaシステム運用API）
Version: v1（Merged Draft）  
BasePath: `/api/v1`  
Prefix: `/system`

> 本仕様書は **第1層（System/K8s）** のみを対象とする。  
> 目的は、`kubectl` / `just` / shell に依存していた **cryptomeria-core のk8s運用**（Helm導入、Pod/Service確認、relayer exec による初期化・接続、スケール、停止・復帰、撤去）を **BFFのHTTP APIとして提供**すること。  
> 認証・権限・ADMIN等の概念は本要件から撤廃し、仕様書でも扱わない。

---

## 1. 共通仕様（System層）

### 1.1 データ形式
- 基本：`application/json; charset=utf-8`
- ログ取得：`text/plain; charset=utf-8`（デフォルト）または `application/x-ndjson`（jsonl）

### 1.2 成功/エラーの基本形
System層は「状態照会系」と「操作系（非同期ジョブ）」で返却の形が少し異なる。

#### (A) 状態照会系（例：`GET /system/status`）
- `200 OK`
- レスポンスは `{ "ok": true, "data": ... }` を基本とする

#### (B) 操作系（例：`POST /system/start`）
- `202 Accepted`
- **jobIdを即時返し、処理はバックグラウンドで実行**する
- job追跡は `/system/jobs/*` で行う

#### 共通エラー（代表例）
- `400 Bad Request`：JSONパース不可、必須パラメータ欠落
- `404 Not Found`：対象リソース不在（jobId、pod等）
- `409 Conflict`：同種ジョブが既にrunning等（排他する設計の場合）
- `422 Unprocessable Entity`：値域/enum不正、steps指定が不正
- `500 Internal Server Error`：k8s接続不可、内部例外
- `504 Gateway Timeout`：外部依存（k8s/helm/exec）の待機が上限に達した（同期処理を採る場合）

---

## 2. ジョブモデル（System層の非同期実行）

System層の「重い操作」は、BFF内部で **ジョブ**として管理する。

### 2.1 Job状態（status）
- `queued`：受理済み、まだ実行開始していない
- `running`：実行中
- `succeeded`：成功
- `failed`：失敗
- `canceled`：キャンセル要求により中断（ベストエフォート）

### 2.2 Job共通フィールド
- `jobId`：一意ID（例：`job_20260123_abcdef`）
- `type`：ジョブ種別（例：`system.start`）
- `createdAt` / `startedAt` / `finishedAt`：ISO8601
- `steps[]`：実行ステップ配列（ステップ別の状態とログ）
- `error`：失敗時の原因（機械可読なcode + message + details）

### 2.3 Jobログ
- BFFが収集する「ジョブログ」を返す（relayer pod内コマンドのstdout/stderrなど）
- relayerそのもののログ（`kubectl logs relayer`相当）とは区別する  
  - ジョブログ：BFFが実行した各ステップの “手順ログ”
  - relayerログ：relayerプロセスの “稼働ログ”

---

## 3. エンドポイント一覧（System層）

### 3.1 POST `/system/start`（start-system相当をジョブ起動）
> **新規要件を反映**：必ず非同期ジョブで開始し、jobIdを即時返却する。

- **目的**  
  `just` などによる手動 `helm install` 後に、システム初期化〜IBC接続完了（start-system相当）を「非同期ジョブ」として起動する。
- **何を提供するか**  
  - start-system の開始要求を受け取り、`jobId` を即時返却（HTTPは待たない）
  - ジョブの実行状態（queued/running/succeeded/failed/canceled）を追跡可能にする
  - 内部では relayer Pod への exec 等を用いて、段階的に処理を進める
- **どんなことに使えるか**  
  - helm install と時間的に分離した「接続処理の開始」
  - 接続処理が長時間でも、ジョブとして進捗・結果・ログを追える
  - 失敗時に「どのステップで落ちたか」を特定して再実行判断できる
- **内部的に必要な情報**  
  - k8s接続情報（in-cluster config / kubeconfig）
  - 対象Namespace（既定：`cryptomeria`）
  - relayer Pod の同定規則（例：`app.kubernetes.io/name=cryptomeria`、`app.kubernetes.io/component=relayer`）
  - exec 実行のための k8s client（pods/exec）
  - 状態監視（pods/log, chain REST/RPC疎通 など）

#### Request
- `Content-Type: application/json`
- Body（省略可：全て既定値で実行できる前提）
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

#### エラー
- `409 Conflict`：同種ジョブが既に running（排他制御している場合）
- `422`：steps が不正、timeoutSeconds が範囲外など
- `500`：k8s接続不可、内部例外

---

### 3.2 GET `/system/jobs`（ジョブ一覧）
- **目的**  
  systemジョブ一覧を取得する（UI/CLIでの追跡用）。
- **何を提供するか**  
  - 直近ジョブの一覧（フィルタ可能）
- **どんなことに使えるか**  
  - 進行中ジョブの確認
  - 失敗ジョブの再確認（jobIdの特定）
- **内部的に必要な情報**  
  - BFF内のジョブストア（インメモリ/永続化は実装方針次第）
  - フィルタリングとページング処理

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

### 3.3 GET `/system/jobs/{jobId}`（ジョブ詳細）
- **目的**  
  ジョブの詳細（進捗・ステップ・エラー）を取得する。
- **何を提供するか**  
  - ジョブの状態
  - 実行ステップの進捗（どこまで完了したか）
  - 失敗時のエラー情報（原因切り分け用）
- **どんなことに使えるか**  
  - “いまどこで止まっているか” の可視化
  - 失敗の再現・再実行判断
- **内部的に必要な情報**  
  - ジョブストア
  - ステップ進捗の記録（開始/終了、メッセージ、stderr要約など）

#### Response
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

#### 失敗時の例（status=failed）
```json
{
  "jobId": "job_20260123_abcdef",
  "type": "system.start",
  "status": "failed",
  "createdAt": "2026-01-23T12:34:56Z",
  "startedAt": "2026-01-23T12:35:10Z",
  "finishedAt": "2026-01-23T12:48:00Z",
  "progress": { "currentStep": "connectAll", "completedSteps": 1, "totalSteps": 4 },
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
      "status": "failed",
      "startedAt": "2026-01-23T12:36:03Z",
      "finishedAt": "2026-01-23T12:48:00Z",
      "message": "rly tx link failed"
    }
  ],
  "result": null,
  "error": {
    "code": "RELAYER_LINK_FAILED",
    "message": "rly tx link failed",
    "details": {
      "chainPair": "mdsc<->fdsc-0",
      "hint": "check chain endpoints and relayer logs"
    }
  }
}
```

#### エラー
- `404 Not Found`：jobIdが存在しない

---

### 3.4 GET `/system/jobs/{jobId}/logs`（ジョブログ取得）
- **目的**  
  ジョブのログを取得する（原因切り分け・進捗確認）。
- **何を提供するか**  
  - BFFが収集したジョブログ（各ステップで実行したコマンドの出力など）
- **どんなことに使えるか**  
  - connect/linkがどこで詰まったかを確認
  - relayer側の出力と突き合わせ
- **内部的に必要な情報**  
  - ジョブごとのログバッファ（ステップごとに追記）
  - 返却時の整形（text/jsonl）とフィルタ（tail/since）

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

### 3.5 POST `/system/jobs/{jobId}/cancel`（ジョブ中断）
- **目的**  
  実行中ジョブを中断する（ベストエフォート）。
- **何を提供するか**  
  - 以降のステップ実行を停止
  - 実行中ステップは “可能なら” 中断（基本はベストエフォート）
- **どんなことに使えるか**  
  - 誤って起動した start-system の停止
  - タイムアウト前に人手介入したい場合
- **内部的に必要な情報**  
  - ジョブ状態の更新
  - 実行ループ（ワーカー）のキャンセルシグナル
  - “中断できない操作” の扱い（実行中execは止められない等）を想定

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

## 4. 状態照会（System層）

### 4.1 GET `/system/status`（健全性要約）
- **目的**  
  Pod/Service/Endpoint と（任意で）Podログを読み、システム健全性を要約する。
- **何を提供するか**  
  - Pods：Ready状況、Restart回数、Phase
  - Services：NodePort/ClusterIP、主要ポート
  - Relayer：稼働推定（プロセス/ログ）
  - Chains：最新heightなど（可能なら）
- **どんなことに使えるか**  
  - 実験開始前の確認
  - 異常検知の一次情報
- **内部的に必要な情報**  
  - Namespace
  - ラベル/探索ルール（cryptomeria関連リソースを絞る）

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "namespace": "cryptomeria",
    "timestamp": "2026-01-23T12:00:00Z",
    "pods": [
      {
        "name": "cryptomeria-mdsc-0",
        "component": "mdsc",
        "instance": "mdsc",
        "phase": "Running",
        "ready": true,
        "restarts": 0
      }
    ],
    "services": [
      {
        "name": "cryptomeria-mdsc-external",
        "type": "NodePort",
        "ports": {
          "rpc": { "port": 26657, "nodePort": 31057 },
          "api": { "port": 1317, "nodePort": 30317 },
          "grpc": { "port": 9090, "nodePort": 30090 }
        }
      }
    ],
    "relayer": {
      "pod": "cryptomeria-relayer-xxxxx",
      "running": true,
      "hint": "use /system/jobs/* for workflow logs"
    },
    "chains": [
      { "chainId": "mdsc", "latestHeight": "1234", "catchingUp": false }
    ]
  }
}
```

---

### 4.2 GET `/system/ports`（ポート一覧）
> **新規要件の参考項**：Serviceを読み、NodePort/ClusterIP と主要ポートを一覧化（チェーン接続先確認用）。

- **目的**  
  cryptomeriaが公開している “接続先一覧（どのServiceのどのポートへ繋ぐか）” をAPIで返す。
- **何を提供するか**  
  - chainIdごとの外部（NodePort）/内部（ClusterIP/DNS）エンドポイント
  - rpc/api/grpc など主要ポートの対応表
- **どんなことに使えるか**  
  - 実験クライアントが接続先を自動解決
  - 手動デバッグ時に「どこにcurlすべきか」を即確認
- **内部的に必要な情報**  
  - Service一覧
  - NodeHost解決（NodePortで外から叩く場合）
  - ラベル/探索ルール（chain Serviceの同定）

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

## 5. k8sリソース参照（System層）

### 5.1 GET `/system/k8s/pods`
- **目的**  
  cryptomeria関連Podを一覧取得する（`kubectl get pods` 相当）。
- **何を提供するか**  
  - Pod一覧（name, labels, phase, ready, restarts, node, startTime）
- **どんなことに使えるか**  
  - 異常Podの特定
  - component/instance別の稼働確認
- **内部的に必要な情報**  
  - Namespace
  - selectorフィルタ

#### Query（任意）
- `component`：例 `relayer|gwc|mdsc|fdsc`
- `instance`：例 `fdsc-0`
- `phase`：例 `Running`

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "name": "cryptomeria-relayer-abcde",
        "namespace": "cryptomeria",
        "labels": {
          "app.kubernetes.io/name": "cryptomeria",
          "app.kubernetes.io/component": "relayer"
        },
        "phase": "Running",
        "ready": true,
        "restarts": 0,
        "node": "minikube",
        "startTime": "2026-01-23T11:50:00Z"
      }
    ]
  }
}
```

---

### 5.2 GET `/system/k8s/services`
- **目的**  
  cryptomeria関連Serviceを一覧取得する（`kubectl get svc` 相当）。
- **何を提供するか**  
  - Service一覧（type, clusterIP, ports, nodePorts, selectors）
- **どんなことに使えるか**  
  - NodePort確認
  - endpoint解決の検証
- **内部的に必要な情報**  
  - Namespace
  - Serviceフィルタ

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "name": "cryptomeria-mdsc-external",
        "type": "NodePort",
        "clusterIP": "10.96.0.10",
        "ports": [
          { "name": "rpc", "port": 26657, "nodePort": 31057, "protocol": "TCP" }
        ],
        "selector": { "app.kubernetes.io/instance": "mdsc" }
      }
    ]
  }
}
```

---

### 5.3 GET `/system/k8s/configmaps`
- **目的**  
  configの存在・キー構造を把握する（原則 “中身は返さない”）。
- **何を提供するか**  
  - ConfigMap一覧（name, keys[]）
- **どんなことに使えるか**  
  - 設定配置の検証
- **内部的に必要な情報**  
  - Namespace

#### Response
- `200 OK`
```json
{
  "ok": true,
  "data": {
    "items": [
      { "name": "cryptomeria-chain-config", "keys": ["config.toml", "app.toml"] }
    ]
  }
}
```

---

### 5.4 GET `/system/k8s/logs`
- **目的**  
  特定Podのログを取得する（`kubectl logs` 相当）。
- **何を提供するか**  
  - tail/sinceSeconds指定ログ
- **どんなことに使えるか**  
  - relayer/chainの稼働確認
- **内部的に必要な情報**  
  - Pod同定（pod名 or component/instanceから解決）

#### Query（任意）
- `pod`：Pod名（優先）
- `component` / `instance`：pod名を解決する場合
- `tail`：既定 200
- `sinceSeconds`：任意

#### Response（例：text）
- `200 OK`
- `Content-Type: text/plain; charset=utf-8`
```
I[2026-01-23T11:50:00Z] starting...
...
```

---

## 6. （任意）Helm操作・スケール・停止/復帰・撤去
> ここは「第1層」の範囲だが、今回の要求は “まず第一層仕様書を出す” なので、エンドポイントは掲載しつつ **詳細は次版で深掘り可能**。

### 6.1 POST `/system/install`（ジョブ推奨）
- 目的：helmでcryptomeriaを導入する（`just deploy`相当）
- 何を提供するか：helm install、待機、結果をジョブで追跡
- どんなことに使えるか：環境自動セットアップ
- 内部的に必要な情報：namespace/release/chartPath/values、helm実行手段

### 6.2 POST `/system/uninstall`（ジョブ推奨）
- 目的：helm uninstall +（任意）PVC等削除
- 何を提供するか：撤去とクリーンアップ
- どんなことに使えるか：再現性のための初期化
- 内部的に必要な情報：削除対象をcryptomeriaに限定する規則

### 6.3 POST `/system/scale/fdsc`（ジョブ推奨）
- 目的：fdsc台数変更＋接続再整備（`scale-fdsc.sh`相当）
- 何を提供するか：helm upgrade→待機→connect→relayer起動
- どんなことに使えるか：スケール実験
- 内部的に必要な情報：helm/exec/チェーン列挙/待機戦略

### 6.4 POST `/system/stop` / `/system/resume`
- 目的：replicas調整で停止/復帰（`just stop/resume`相当）
- 何を提供するか：対象リソースのスケール制御
- どんなことに使えるか：実験区切り・資源節約
- 内部的に必要な情報：対象Deployment/StatefulSetの探索規則

---

## 7. 付録：System層が参照する内部情報（要点のみ）
- `K8S_NAMESPACE`：操作対象namespace（既定 `cryptomeria`）
- `HELM_RELEASE`：helm操作対象リリース（例 `cryptomeria`）
- `HELM_CHART_PATH`：適用するChartパス（固定推奨）
- `NODE_HOST` / `AUTO_DETECT_NODE_HOST`：NodePortの接続先解決（外部から叩く場合）
- 探索ルール（推奨）：  
  - `app.kubernetes.io/name=cryptomeria`  
  - `app.kubernetes.io/category=chain`  
  - `app.kubernetes.io/instance`（例：mdsc, fdsc-0）  
  - `app.kubernetes.io/component`（例：relayer, mdsc, fdsc）

---
