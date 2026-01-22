# テスト要件書（Cryptomeria-BFF v1 / API全エンドポイント）

最終更新: 2026-01-23  
対象: API第一層〜第三層 + Jobs（System/Utils）  
目的: 各エンドポイントについて「正常系・異常系・評価観点」を定義し、実装/回帰テストの基準にする。

---

## 0. テスト前提（共通）

### 前提環境
- Cryptomeria-core が **Helmでインストール済み**（v1は helm install/uninstall は範囲外）。
- BFF は **クラスタ外で動作**し、Kubernetes API にアクセスできる kubeconfig を保持。
- テスト用 namespace（例: `cryptomeria`）が存在し、チェーンPod/relayer Pod が稼働（または停止状態を意図的に作れる）。

### 共通確認項目（全API）
- Content-Type: JSON系は `application/json; charset=utf-8`
- エラー形式: `{"error":{"code","message","details"}}`
- 異常時のHTTPステータスが仕様通り（400/404/409/429/502/503/500）
- 機密情報（kubeconfig/token/mnemonic/秘密鍵/txBytes生）をレスポンス・ログに含めない

---

# 1. 第一層（System / K8s）テスト要件

## 1.1 GET /api/v1/system/status
### 何を行うエンドポイントか
- システム稼働状況（Pods/Relayer/Chains）の要約を返す

### 正常入力
- クエリなし
- `?verbose=true`

### 想定される正常出力
- 200
- JSONに以下が含まれる
  - `namespace`, `observedAt`
  - `summary.podsTotal/podsReady/podsNotReady/restartsTotal`
  - `relayer.podName/ready/rlyRunning`
  - `chains[]`（chainId, podName, ready）

### 異常入力
- なし（入力は任意）

### 想定される異常出力
- 503 `K8S_UNAVAILABLE`（K8s API 到達不可）

### その他評価項目
- verbose=true で chains/services 情報が増える（ただし機密は含めない）
- 連続呼び出しで安定して返る（レース/例外がない）

---

## 1.2 GET /api/v1/system/preflight
### 何を行うエンドポイントか
- `/system/start` 前提（namespace存在、relayer pod存在、pods/exec可、chain pods ready 等）をチェックし説明付きで返す

### 正常入力
- クエリなし

### 想定される正常出力
- 200
- `overallOk=true/false`
- `checks[]` に name/ok/details が並ぶ

### 異常入力
- なし

### 想定される異常出力
- 503 `K8S_UNAVAILABLE`（K8s API 不達）

### その他評価項目
- `overallOk=false` の場合でも 200 で返し、**どのチェックが落ちたか**が説明される
- exec権限不足を検知できる（pods/execがForbidden等）

---

## 1.3 GET /api/v1/system/topology
### 何を行うエンドポイントか
- chain pod と service/port（nodePort等）の対応をまとめて返す

### 正常入力
- クエリなし

### 想定される正常出力
- 200
- `chains[]` に `pod`, `service`, `ports[]` が含まれる

### 異常入力
- なし

### 想定される異常出力
- 503 `K8S_UNAVAILABLE`

### その他評価項目
- service未検出のchainがいても、pods起点のchainは返し、service情報は欠損扱い（null/省略）で落ちない

---

## 1.4 GET /api/v1/system/k8s/pods
### 何を行うエンドポイントか
- namespace内のPod一覧を返す（selector/name/コンテナ情報など）

### 正常入力
- `?selector=app.kubernetes.io/component=relayer`
- `?name=gwc`
- `?includeContainers=true`

### 想定される正常出力
- 200
- `items[]` に `name/namespace/labels/phase/ready/restarts/podIP` など

### 異常入力
- `selector` が不正（例: `a==b`）
- `includeContainers=xxx`（booleanでない）

### 想定される異常出力
- 400 `INVALID_ARGUMENT`（details.field=selector等）
- 503 `K8S_UNAVAILABLE`

### その他評価項目
- itemsが0でも200で返る
- 返すlabelsの量が大きすぎない（必要なら絞る）

---

## 1.5 GET /api/v1/system/k8s/services
### 何を行うエンドポイントか
- Service一覧（type/ports/selector等）を返す

### 正常入力
- `?selector=app.kubernetes.io/name=cryptomeria`
- `?name=cryptomeria-gwc`

### 想定される正常出力
- 200
- `items[]` に `name/type/clusterIP/ports[]/selector`

### 異常入力
- 不正selector

### 想定される異常出力
- 400 `INVALID_ARGUMENT`
- 503 `K8S_UNAVAILABLE`

### その他評価項目
- NodePortのnodePort値が取れること
- Service未存在でも200でitems空

---

## 1.6 GET /api/v1/system/k8s/endpoints
### 何を行うエンドポイントか
- Endpoints一覧を返す（Service解決の補助）

### 正常入力
- `?name=cryptomeria-gwc`

### 想定される正常出力
- 200
- `items[]` に subsets/address/ports 情報

### 異常入力
- 不正selector

### 想定される異常出力
- 400 `INVALID_ARGUMENT`
- 503 `K8S_UNAVAILABLE`

### その他評価項目
- Endpointsが空でも落ちない（headless等を想定）

---

## 1.7 GET /api/v1/system/k8s/configmaps（任意）
### 何を行うエンドポイントか
- ConfigMap一覧（原則 keys のみ）を返す

### 正常入力
- `?name=xxx`
- `?includeData=false`
- `?includeData=true`（慎重）

### 想定される正常出力
- 200
- `items[]` に `name`, `keys[]`
- includeData=trueなら `data` を含む（ただし機密注意）

### 異常入力
- includeData不正

### 想定される異常出力
- 400 `INVALID_ARGUMENT`
- 503 `K8S_UNAVAILABLE`

### その他評価項目
- dataを返す際も機密が混ざらない運用であること（最低限、仕様上は慎重推奨）

---

## 1.8 GET /api/v1/system/k8s/logs
### 何を行うエンドポイントか
- Podログを取得（text/plain）

### 正常入力
- `?podName=cryptomeria-relayer-xxxxx`
- `?podName=...&tailLines=200`
- `?podName=...&sinceSeconds=60`

### 想定される正常出力
- 200（`text/plain; charset=utf-8`）
- ログ文字列が返る（空でも可）

### 異常入力
- `podName` 未指定
- tailLinesが範囲外（負数など）

### 想定される異常出力
- 400 `INVALID_ARGUMENT`（podName必須）
- 404 `NOT_FOUND`（pod存在しない）
- 503 `K8S_UNAVAILABLE`

### その他評価項目
- ログ取得が大きすぎない（tailLines上限）
- 取得対象が存在しない場合の説明が明確

---

## 1.9 POST /api/v1/system/start
### 何を行うエンドポイントか
- start-system相当（discover→initRelayer→connectAll→startRelayer→waitReady）をジョブで実行

### 正常入力
- Body:
  - `{"force":false,"timeoutMs":600000,"dryRun":false}`
- dryRun:
  - `{"force":false,"timeoutMs":600000,"dryRun":true}`

### 想定される正常出力
- dryRun=false:
  - 202 + `{jobId,type,status,createdAt}`
- dryRun=true:
  - 200 + `plan[]`（skip/run と理由）

### 異常入力
- timeoutMsが小さすぎる/負数
- forceがbooleanでない
- dryRunがbooleanでない

### 想定される異常出力
- 400 `INVALID_ARGUMENT`
- 409 `CONFLICT`（system.* ジョブが既にrunning）
- 503 `K8S_UNAVAILABLE`

### その他評価項目
- force=falseでの冪等性:
  - 2回目実行で多くのstepが `skipped` になる
- ジョブログに mnemonic/秘密情報を出さない
- timeoutMs超過で job が failed + TIMEOUT（Job仕様に準拠）

---

## 1.10 POST /api/v1/system/connect
### 何を行うエンドポイントか
- connect-all / connect-chain相当をジョブで実行

### 正常入力
- `{"force":false,"timeoutMs":600000,"target":"all"}`
- `{"force":false,"timeoutMs":600000,"target":"chain:fdsc-0"}`

### 想定される正常出力
- 202 + jobId

### 異常入力
- target形式不正（`"fdsc-0"` など）
- timeoutMs不正

### 想定される異常出力
- 400 `INVALID_ARGUMENT`
- 409 `CONFLICT`（system.* running）
- 503 `K8S_UNAVAILABLE`

### その他評価項目
- target=chain で部分再実行できる
- 既に接続済みならstepがskippedになる（force=false）

---

## 1.11 POST /api/v1/system/relayer/restart（任意）
### 何を行うエンドポイントか
- rly start の再起動をジョブで実行

### 正常入力
- `{"timeoutMs":120000}`

### 想定される正常出力
- 202 + jobId

### 異常入力
- timeoutMs不正

### 想定される異常出力
- 400 `INVALID_ARGUMENT`
- 409 `CONFLICT`（system.* running）
- 503 `K8S_UNAVAILABLE`

### その他評価項目
- restart後に `system/status.relayer.rlyRunning=true` へ戻る

---

## 1.12 System Jobs（共通）
### 対象エンドポイント
- GET  `/api/v1/system/jobs`
- GET  `/api/v1/system/jobs/{jobId}`
- GET  `/api/v1/system/jobs/{jobId}/logs`
- POST `/api/v1/system/jobs/{jobId}/cancel`

### 何を行うエンドポイントか
- systemスコープのジョブを一覧/詳細/ログ/キャンセルする

### 正常入力
- `GET /jobs?status=running&limit=50`
- `GET /jobs/{jobId}`
- `GET /jobs/{jobId}/logs?tailLines=200`
- `POST /jobs/{jobId}/cancel`

### 想定される正常出力
- 200（一覧/詳細/ログ/キャンセル）
- logsは `text/plain`

### 異常入力
- jobId不正（存在しない）
- tailLines範囲外

### 想定される異常出力
- 404 `NOT_FOUND`（BFF再起動後にjob消失含む）
- 400 `INVALID_ARGUMENT`（tailLines等）
- 409 `CONFLICT`（既に終了済みジョブをcancel）

### その他評価項目
- BFF再起動でジョブがクリアされる（期待通り 404）
- ログサイズ上限が効く（OOMしない）
- cancelはbest-effortで status=canceled へ遷移

---

# 2. 第二層（Blockchain）テスト要件

## 2.1 GET /api/v1/chains
### 何を行うエンドポイントか
- Pod起点でチェーン一覧を返す（include=endpoints時のみendpoint解決）

### 正常入力
- `GET /chains`
- `GET /chains?include=endpoints`
- `GET /chains?include=endpoints&mode=external`
- `GET /chains?mode=auto`

### 想定される正常出力
- 200
- `items[]` に `chainId`, `pod{name,ready}`
- include=endpoints時のみ `endpoints{rpc,rest}` が可能なら含まれる

### 異常入力
- mode不正（`mode=hoge`）

### 想定される異常出力
- 400 `INVALID_ARGUMENT`
- 503 `UPSTREAM_UNAVAILABLE`（K8s API不達等）

### その他評価項目
- Podが存在しないchainIdは返らない
- endpoint解決失敗でも一覧自体は返り、endpointsは欠損扱いで落ちない

---

## 2.2 GET /api/v1/chains/{chainId}/info
### 何を行うエンドポイントか
- チェーン基本情報（nodeInfo/syncInfo等）を返す

### 正常入力
- `GET /chains/gwc/info`
- `GET /chains/gwc/info?mode=external`

### 想定される正常出力
- 200
- `chainId`, `nodeInfo`, `syncInfo.latestBlockHeight/latestBlockTime` が含まれる

### 異常入力
- chainId不明
- mode不正

### 想定される異常出力
- 404 `NOT_FOUND`（Podが無い）
- 400 `INVALID_ARGUMENT`
- 503 `UPSTREAM_UNAVAILABLE`（RPC/REST不達）
- 502 `UPSTREAM_ERROR`（上流がエラー）

### その他評価項目
- 上流不達と上流エラーの識別ができる

---

## 2.3 GET /api/v1/chains/{chainId}/status
### 何を行うエンドポイントか
- チェーンの状態（latestHeight/latestTime/catchingUp等）を返す

### 正常入力
- `GET /chains/gwc/status`

### 想定される正常出力
- 200
- `latestHeight`, `latestTime`, `catchingUp` が含まれる

### 異常入力
- chainId不明

### 想定される異常出力
- 404 / 503 / 502

### その他評価項目
- latestHeightが増加する（時間をおいて再取得で確認）

---

## 2.4 GET /api/v1/chains/{chainId}/mempool
### 何を行うエンドポイントか
- mempoolを返す（サイズ、tx一覧等）

### 正常入力
- `GET /chains/gwc/mempool`

### 想定される正常出力
- 200
- `size`, `txs[]`（空でも可）

### 異常入力
- chainId不明

### 想定される異常出力
- 404 / 503 / 502

### その他評価項目
- txsが巨大になり得る場合のサイズ制御（実装方針があるなら確認）

---

## 2.5 GET /api/v1/chains/{chainId}/blocks/latest
### 正常入力
- `GET /chains/gwc/blocks/latest`

### 想定される正常出力
- 200
- `height`, `hash`, `time`, `txCount`

### 異常入力
- chainId不明

### 想定される異常出力
- 404 / 503 / 502

### その他評価項目
- 連続取得で height が単調増加（停止時は一定）

---

## 2.6 GET /api/v1/chains/{chainId}/blocks/{height}
### 正常入力
- `GET /chains/gwc/blocks/1`
- `GET /chains/gwc/blocks/12345?detail=true`

### 想定される正常出力
- 200
- `height`, `hash`, `time`, `txCount`
- detail=trueで詳細が増える（仕様に沿う）

### 異常入力
- heightが非数（`abc`）
- heightが負数
- chainId不明

### 想定される異常出力
- 400 `INVALID_ARGUMENT`（height不正）
- 404 `NOT_FOUND`（存在しないheightの扱いは上流準拠。実装方針で固定するなら確認）
- 503 / 502

### その他評価項目
- detailの有無でpayloadサイズが変わる（過大化しない）

---

## 2.7 GET /api/v1/chains/{chainId}/blocks/{height}/txs
### 正常入力
- `GET /chains/gwc/blocks/12345/txs`
- `GET /chains/gwc/blocks/12345/txs?format=hash`
- `GET /chains/gwc/blocks/12345/txs?format=base64`

### 想定される正常出力
- 200
- `height`, `txs[]`（hash or base64）

### 異常入力
- format不正（`format=json`）
- height不正

### 想定される異常出力
- 400 `INVALID_ARGUMENT`
- 503 / 502

### その他評価項目
- base64返却時のサイズが大きい場合の制限（必要なら後で要件追加）

---

## 2.8 GET /api/v1/chains/{chainId}/tx/{txhash}
### 正常入力
- 既知txhashで `GET /chains/gwc/tx/{txhash}`

### 想定される正常出力
- 200
- `txhash`, `height`, `code`, `rawLog`, `events[]` 等

### 異常入力
- txhash形式不正（空/短すぎ）
- 未確定txhash（まだ見つからない）
- chainId不明

### 想定される異常出力
- 400 `INVALID_ARGUMENT`（形式不正を弾く場合）
- 404 `NOT_FOUND`（未確定/見つからない）
- 503 / 502

### その他評価項目
- 未確定→確定で 404→200 に遷移すること

---

## 2.9 GET /api/v1/chains/{chainId}/accounts/{address}
### 正常入力
- `GET /chains/gwc/accounts/{address}`（既知のアドレス）

### 想定される正常出力
- 200
- `address`, `accountNumber`, `sequence`, `balances[]`

### 異常入力
- address形式不正
- chainId不明

### 想定される異常出力
- 400 `INVALID_ARGUMENT`（形式不正）
- 404 / 503 / 502

### その他評価項目
- 0 balanceでも balances が空 or 0 を表現できる

---

## 2.10 POST /api/v1/chains/{chainId}/simulate
### 正常入力
- Body: `{"txBytesBase64":"..."}`（署名済み/未署名は上流仕様に合わせる）

### 想定される正常出力
- 200
- `gasWanted`, `gasUsed`

### 異常入力
- txBytesBase64未指定
- base64不正
- chainId不明

### 想定される異常出力
- 400 `INVALID_ARGUMENT`
- 404 / 503 / 502

### その他評価項目
- 異常txで上流が返すエラーを 502/400 のどちらで返すかを実装で統一（回帰のため）

---

## 2.11 POST /api/v1/chains/{chainId}/broadcast
### 正常入力
- Body: `{"txBytesBase64":"...","broadcastMode":"sync"}`

### 想定される正常出力
- 200
- `txhash`, `height`, `code`, `rawLog`, `gasWanted`, `gasUsed`

### 異常入力
- broadcastMode不正
- txBytesBase64不正
- chainId不明

### 想定される異常出力
- 400 `INVALID_ARGUMENT`
- 404 / 503 / 502

### その他評価項目
- broadcast後に `/tx/{txhash}` で確認できる（整合性テスト）

---

## 2.12 GET /api/v1/chains/{chainId}/blocktime
### 何を行うエンドポイントか
- 固定定義（ヘッダ時刻ベース）でブロック時間統計を返す + windowキャッシュ

### 正常入力
- `GET /chains/gwc/blocktime`（default window=100）
- `GET /chains/gwc/blocktime?window=200&useCache=true&ttlSeconds=10`

### 想定される正常出力
- 200
- `range{startHeight,endHeight}`, `timeStart`, `timeEnd`, `durationSeconds`, `stats{mean/min/max/pXX}`, `cached`, `computedAt`

### 異常入力
- window < 2
- window > 2000
- ttlSeconds不正（負数/過大）
- chainId不明

### 想定される異常出力
- 400 `INVALID_ARGUMENT`
- 404 `NOT_FOUND`
- 503/502

### その他評価項目（重要）
- キャッシュ確認:
  - 連続2回呼び出しで **同一latestHeight** の場合 `cached=true`
  - latestHeightが変わった場合 `cached=false` で再計算される

---

# 3. 第三層（Utilities / Experiment）テスト要件

## 3.1 POST /api/v1/utils/observe/tx-confirmation（ジョブ）
### 何を行うエンドポイントか
- txが確定するまで待機して結果（latency等）を返す（非同期ジョブ）

### 正常入力
- Body:
  - `{"chainId":"gwc","txhash":"...","timeoutMs":300000,"pollIntervalMs":1000}`

### 想定される正常出力
- 202 + jobId
- job result（succeeded）に:
  - `confirmed=true`, `height`, `firstSeenAt`, `confirmedAt`, `latencyMs`

### 異常入力
- timeoutMs < 1000
- pollIntervalMs < 200
- txhash空/形式不正
- chainId不明

### 想定される異常出力
- 400 `INVALID_ARGUMENT`
- 202後のジョブが timeout で failed（JobError.code=TIMEOUT 等）
- 404 `NOT_FOUND`（chainId不明）

### その他評価項目
- poll間隔通りに問い合わせている（過剰負荷にならない）
- 未確定txhashが確定した瞬間に成功へ遷移する

---

## 3.2 POST /api/v1/utils/observe/tx-confirmation-batch（ジョブ）
### 何を行うエンドポイントか
- 複数txhashの確定待ち + 集計

### 正常入力
- `{"chainId":"gwc","txhashes":["a","b"],"timeoutMs":300000,"pollIntervalMs":1000,"maxConcurrency":20,"stopOnFirstError":false}`

### 想定される正常出力
- 202 + jobId
- job result に `summary{total,succeeded,failed,durationMs}` と `items[]`

### 異常入力
- txhashesが空
- txhashes.length > maxBatchSize
- maxConcurrency > maxConcurrencyLimit
- pollIntervalMs不正

### 想定される異常出力
- 400 `INVALID_ARGUMENT`（サイズ/形式）
- 429 `RATE_LIMITED`（並列上限/実行上限に達した場合）

### その他評価項目
- stopOnFirstError=true で早期終了する
- 一部失敗でも集計が妥当（failed/succeededが一致）

---

## 3.3 POST /api/v1/utils/metrics/throughput（ジョブ）
### 何を行うエンドポイントか
- 固定定義（ヘッダ時刻ベース）で TPS/throughput を算出

### 正常入力
- `{"chainId":"gwc","window":100,"mode":"auto","timeoutMs":120000}`

### 想定される正常出力
- 202 + jobId
- job result に:
  - `range{startHeight,endHeight}`
  - `timeStart/timeEnd`
  - `durationSeconds`
  - `totalTx`
  - `tps`
  - `computedAt`

### 異常入力
- window < 2 / > 2000
- timeoutMs不正
- chainId不明

### 想定される異常出力
- 400 `INVALID_ARGUMENT`
- 404 `NOT_FOUND`
- ジョブが上流不達で failed（UPSTREAM_UNAVAILABLE）

### その他評価項目（重要）
- 結果が「仕様の固定定義」通り（durationSecondsがheaderTime差分であること）
- durationSeconds=0 の場合の扱い（0除算回避）
  - 想定: failed + INVALID_STATE or INTERNAL（実装で一貫させる）

---

## 3.4 POST /api/v1/utils/metrics/resource-snapshot（ジョブ）
### 何を行うエンドポイントか
- system + chain の状態をまとめて採取して返す（実験ログ用）

### 正常入力
- `{"namespace":"cryptomeria","include":["systemStatus","pods","services","chainsStatus"],"timeoutMs":60000}`

### 想定される正常出力
- 202 + jobId
- job result に `observedAt/namespace` と includeした各データ

### 異常入力
- include不正（未知の値）
- timeoutMs不正

### 想定される異常出力
- 400 `INVALID_ARGUMENT`
- 503 `K8S_UNAVAILABLE`（ジョブ内でfailedにしても良いが、扱いは統一）

### その他評価項目
- snapshotはbest-effort（chainStatusの一部失敗でも全体を失敗にしない/する、方針を固定して回帰可能に）
- payloadが大きくなり過ぎない（必要ならフィールド削減）

---

## 3.5 POST /api/v1/utils/load/broadcast-batch（ジョブ）
### 何を行うエンドポイントか
- 署名済Txを並列broadcastし成功率/エラーを集計

### 正常入力
- `{"chainId":"gwc","txBytesBase64List":["...","..."],"broadcastMode":"sync","maxConcurrency":20,"timeoutMs":300000,"stopOnFirstError":false}`

### 想定される正常出力
- 202 + jobId
- job result に `summary` と `items[{index,txhash,ok,error?}]`

### 異常入力
- txBytesBase64Listが空
- list長 > maxBatchSize
- maxConcurrency > limit
- broadcastMode不正

### 想定される異常出力
- 400 `INVALID_ARGUMENT`
- 429 `RATE_LIMITED`
- 上流不達で failed（UPSTREAM_UNAVAILABLE）

### その他評価項目
- 並列数が上限を守る（サーバ側強制）
- stopOnFirstError=true で早期停止
- txBytes本体をログに出さない（件数のみ）

---

## 3.6 POST /api/v1/utils/load/broadcast-and-confirm（ジョブ）
### 何を行うエンドポイントか
- broadcast後、各txhashの確定まで追跡し統計を返す

### 正常入力
- `{"chainId":"gwc","txBytesBase64List":["..."],"broadcastMode":"sync","maxConcurrency":10,"timeoutMs":600000,"pollIntervalMs":1000}`

### 想定される正常出力
- 202 + jobId
- job result に:
  - `items[{index,txhash,confirmed,latencyMs,height?}]`
  - `summary`

### 異常入力
- pollIntervalMs < 200
- timeoutMs不正
- list長 > maxBatchSize
- maxConcurrency > limit

### 想定される異常出力
- 400 `INVALID_ARGUMENT`
- 429 `RATE_LIMITED`
- timeoutで failed（TIMEOUT）

### その他評価項目
- broadcast失敗したtxの扱い（confirmed待ちに入らない等）を一貫させる
- 部分成功時の集計が正しい

---

## 3.7 Utils Jobs（共通）
### 対象エンドポイント
- GET  `/api/v1/utils/jobs`
- GET  `/api/v1/utils/jobs/{jobId}`
- GET  `/api/v1/utils/jobs/{jobId}/logs`
- POST `/api/v1/utils/jobs/{jobId}/cancel`

### テスト観点
- System Jobs と同様（一覧/詳細/ログ/キャンセル、404、ログ上限、再起動で消える）

---

# 4. ジョブ共通（APIJOB）テスト要件

## 4.1 状態遷移テスト
- queued → running → succeeded
- queued → canceled（開始前キャンセル）
- running → canceled（途中キャンセル）
- running → failed（例外・上流不達）
- running → failed（timeout）

## 4.2 ステップ状態テスト
- stepが順番に pending→running→succeeded
- 冪等判定による skipped が正しく記録される（system.start など）

## 4.3 ログテスト
- logs が append-only で増える
- tailLines が効く
- 上限（例: 5MB/ジョブ）を超えてもOOMしない

## 4.4 排他/上限テスト
- system.* ジョブ同時実行で 409
- utils の maxRunningJobs 超過で 429

## 4.5 再起動影響テスト
- BFF再起動後、既存jobIdが 404 になる（仕様通り）
- 再起動後に system.start を再実行しても、force=falseなら多くが skipped（状態冪等で復帰できる）

---

# 5. 付録：優先度（推奨）

- P0（最優先）
  - /system/preflight, /system/start, System Jobs
  - /chains（pod起点）, /chains/{id}/broadcast, /chains/{id}/tx/{hash}
  - /utils/observe/tx-confirmation, /utils/metrics/resource-snapshot

- P1（次点）
  - /system/topology, /system/k8s/logs
  - /chains/{id}/blocktime（キャッシュ含む）
  - /utils/metrics/throughput, /utils/load/broadcast-batch

- P2（余裕があれば）
  - /utils/load/broadcast-and-confirm
  - configmaps/endpoints詳細など周辺強化
