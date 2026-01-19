# 実験用APIサーバー要件（Cryptomeria）

## 1. 背景・目的
卒業研究の実験（`docs/実験/卒業研究実験案.md` の A〜F）を回すにあたり、毎回手動で `kubectl exec`・`kubectl cp`・`port-forward`・bashスクリプトを叩く運用は、
- 操作コストが高い
- 手順ミス/環境差分が起きやすい
- パラメータと結果（ログ/タイミング/ハッシュ）が紐づかず再現性が下がる

という問題がある。

そこで **Cryptomeria-core（Kubernetes上の GWC/MDSC/FDSC/Relayer）を、オフチェーンのAPIサーバーから統一的に操作・計測・結果保存できるようにする**。

実装は **TypeScript + Hono** を前提とする。

---

## 2. スコープ
### 2.1 対象
- Kubernetes上のCryptomeria-core（Helmデプロイ）
  - GWC（Gateway chain）
  - MDSC（Meta store chain）
  - FDSC（File data store chain、複数）
  - Relayer（Go relayer）
- 実験支援（A〜F）のための操作・計測・結果保存

### 2.2 非目標（この段階ではやらない）
- Cryptomeria-coreのオンチェーン仕様変更（メトリクス実装等は「将来対応」に記載）
- 汎用K8s管理ツール化（本APIは実験用途に最適化）

---

## 3. 前提（Cryptomeria-core側の前提）
本要件は、現行リポジトリの運用前提に合わせる。

- Namespace: `cryptomeria`（既定）
- Podラベル（実験案.mdの前提）
  - `app.kubernetes.io/component=gwc|mdsc|fdsc|relayer`
- Service（Helmテンプレート）
  - `cryptomeria-gwc`（API:1317）
  - `cryptomeria-mdsc`（API:1317）
  - `cryptomeria-fdsc-0`, `cryptomeria-fdsc-1`, ...（API:1317）
- /render は **GWCのREST(1317)上のHTTPルート**として提供される
- チェーンID（Helmの `CHAIN_INSTANCE_NAME`）
  - `gwc`, `mdsc`, `fdsc-0`, `fdsc-1`, ...
- CLIの想定（Pod内に配置済み）
  - GWC: `gwcd`
  - MDSC: `mdscd`
  - FDSC: `fdscd`
- CLI home（Helm volumeMount）
  - `/home/gwc/.gwc`
  - `/home/mdsc/.mdsc`
  - `/home/fdsc/.fdsc`
- Tx送信アカウント（実験案.mdの例）
  - `--from local-admin`
  - `--keyring-backend test`


---

## 4. APIとCryptomeria-coreを接続するために必要な情報
APIサーバーが「どのクラスタのどのコンポーネント」に、どの方法でアクセスするかを設定できる必要がある。

### 4.1 Kubernetes接続情報（方式B：クラスタ外実行を基本）
本APIサーバーは **方式B（ローカル/別VMで実行）をデフォルト**とする。卒業研究では実験のPDCA速度を優先し、コード修正→再起動→再実験を最短で回すため。

#### 4.1.1 方式Bで必要な情報（最小）
- **KUBECONFIG**（推奨）：`KUBECONFIG=/path/to/kubeconfig` またはデフォルトパス（`~/.kube/config`）
  - 利用する **context名** を固定できること（誤コンテキスト防止）
- **到達性**：APIサーバー実行環境から Kubernetes API Server へ到達できるネットワーク（VPN/FW含む）
- **Namespace**：例 `cryptomeria`

#### 4.1.2 方式Bで推奨する追加情報（運用を楽にする）
- **Pod/Service発見ルール**：ラベルセレクタ（4.2参照）
- **クラスタ内Serviceへの到達方法**（ClusterIPのみの場合）
  - 方式Bでは `cryptomeria-gwc:1317` のような **クラスタ内DNS名はそのままでは引けない**ことが多い。
  - 対策として次のどちらかを採用する。
    - **B-1（簡単）**：実験者が事前に `kubectl port-forward` を張り、APIサーバーは `http://127.0.0.1:<port>` を使う
    - **B-2（推奨）**：APIサーバーがK8s API経由で port-forward を自動確立し、内部で接続先を解決する（※実装コストは上がるが再現性が高い）

#### 4.1.3 必要権限（方式B/Aで共通の最小セット目安）
方式Bでは kubeconfig 側の権限で担保される。将来方式Aに移行する際は、この権限をRBACで付与する。
- get/list/watch: pods, services, endpoints, statefulsets, deployments
- pods/exec: 実験コマンド実行に必要（upload, cpu-hog等）
- pods/log: relayer/chainログ収集
- （任意）create/patch: jobs（ジョブ実行する場合）, statefulsets（スケール操作する場合）

#### 4.1.4 将来 方式A（クラスタ内デプロイ）へ移行するための設計メモ
方式Bで開発しつつ、後で方式Aにスムーズに移せるよう、**K8s接続の初期化を差し替え可能**に設計する。

- **接続モード切替**
  - `K8S_MODE=external|incluster`（既定：`external`）
  - external: `KubeConfig.loadFromDefault()`（KUBECONFIG/デフォルトパス）
  - incluster: `KubeConfig.loadFromCluster()`（ServiceAccountトークン）

- **K8sクライアント生成の抽象化**
  - `createK8sClients(mode): { coreV1, appsV1, ... }` のようなファクトリを用意
  - 以降の実装（pods一覧/exec/log/port-forward）はこのクライアントのみを見る

- **RBACは「方式Bの最小権限」をそのまま写経**
  - 4.1.3の最小権限を `Role/RoleBinding`（namespace scoped）で付与
  - 将来、スケールやジョブ実行を使う場合のみ権限を追加

- **デプロイ形態**
  - 方式Bの時点で Dockerfile を用意しておく（ローカル実行でも使える）
  - 方式A移行時は Helm chart か manifest を追加し、`ServiceAccount` を紐付けるだけで動く状態を目指す


### 4.2 暗黙依存を避けるための「発見（discovery）」情報
手動でpod名を埋め込まず、ラベルから動的に解決する。

- Namespace（例：`cryptomeria`）
- ラベルセレクタ
  - gwc pod: `app.kubernetes.io/component=gwc`
  - mdsc pod: `app.kubernetes.io/component=mdsc`
  - fdsc pods: `app.kubernetes.io/component=fdsc`（複数）
  - relayer pod: `app.kubernetes.io/component=relayer`
- 1コンポーネント複数podの扱い
  - gwc/mdsc/relayer: 通常1pod（先頭を使う）
  - fdsc: `app.kubernetes.io/instance=fdsc-0` などの instanceラベルで個別識別

### 4.3 Cryptomeria-core（チェーン）アクセス情報
APIサーバーは「REST経由の参照」と「CLI経由のTx送信」を使い分ける。

- REST（参照系）
  - GWC: `http://cryptomeria-gwc:1317`
    - `/render?project=...&path=...&version=...`
    - `/gwc/gateway/v1/storage_endpoints`
  - MDSC: `http://cryptomeria-mdsc:1317`
    - `/mdsc/metastore/v1/manifest/{project_name}`
  - FDSC(i): `http://cryptomeria-fdsc-{i}:1317`
    - `/fdsc/datastore/v1/fragment/{fragment_id}`
    - `/fdsc/datastore/v1/fragment?pagination...`

- CLI（Tx送信・一部クエリ）
  - gwc pod内で `gwcd tx gateway upload ...` を実行（実験案.md準拠）
  - chain-id: `gwc`（fdscは `fdsc-0` 等）
  - key: `local-admin`（`--keyring-backend test`）
  - home:
    - GWC: `/home/gwc/.gwc`
    - MDSC: `/home/mdsc/.mdsc`
    - FDSC: `/home/fdsc/.fdsc`

### 4.4 APIサーバー側の設定（例：環境変数）
最低限、以下が設定可能であること。

- `K8S_NAMESPACE=cryptomeria`
- `LABEL_GWC=app.kubernetes.io/component=gwc`
- `LABEL_MDSC=app.kubernetes.io/component=mdsc`
- `LABEL_FDSC=app.kubernetes.io/component=fdsc`
- `LABEL_RELAYER=app.kubernetes.io/component=relayer`
- `GWC_SERVICE_BASE=http://cryptomeria-gwc:1317`
- `MDSC_SERVICE_BASE=http://cryptomeria-mdsc:1317`
- `FDSC_SERVICE_BASE_TEMPLATE=http://cryptomeria-fdsc-{i}:1317`
- `GWC_CLI_HOME=/home/gwc/.gwc`
- `GWC_CHAIN_ID=gwc`
- `TX_FROM=local-admin`
- `TX_KEYRING_BACKEND=test`


---

## 5. 実験を行い、結果を確認したりするために必要な機能
実験案.md（A〜F）を「API呼び出しだけ」で完結させるため、以下の機能を要求する。

### 5.1 コア操作（MVP）
1) **システム状態の取得**
- GWC/MDSC/FDSC/Relayer のpod一覧、ready状態、再起動回数
- 主要Serviceの到達性（HTTP 200/404含む疎通）

2) **アップロード実行（GWC）**
- zip/単一ファイルを受け取り、GWCへ upload Tx を投げる
- `txhash` と開始時刻を記録
- （任意）Tx失敗時に `raw_log` を返す

3) **マニフェストの出現待ち（MDSC）**
- `/mdsc/metastore/v1/manifest/{project}` をポーリングして「可視化までの時間」を測る

4) **復元取得（GWC /render）**
- `/render?project=...&path=...&version=...` でファイルを取得
- 取得失敗（404/500/タイムアウト）を結果に記録

5) **ハッシュ照合（実験A）**
- 入力zipをAPI側で展開し、全ファイルを列挙
- それぞれを `/render` で取得して sha256 を比較
- mismatch一覧（パス、local hash、remote hash）を保存

6) **Tx情報取得（実験B）**
- `gwcd query tx <hash>`（またはRPC/REST）で height/code/log を取得

7) **ログ収集（実験B/E）**
- relayerログ（timestamps付き、since指定、tail指定）
- 必要に応じてgwc/mdsc/fdscのログも取得

8) **FDSC格納数の確認（実験D）**
- 各FDSCに対し `ListFragment`（`/fdsc/datastore/v1/fragment?...count_total...`）で総数を取得
- 台数ごとの偏り（RRの公平性）の計算素材として保存

9) **並列実行（実験F）**
- N並列で upload→manifest可視化 を走らせ、E2E時間分布を保存
- 失敗したジョブの失敗理由（Tx失敗、manifest待ちタイムアウト等）を保存

10) **結果保存・一覧・エクスポート**
- 実験runをIDで管理し、後から参照できる
- JSON/CSVでエクスポート

### 5.2 追加機能（推奨・Optional）
- **スケール変更（実験D）**
  - FDSC台数を変更（Helm upgrade相当）
  - ※Service増減が絡むため「Helmを叩く」方式が現実的
- **障害注入（実験E）**
  - 特定FDSCにCPU hog（例：`yes > /dev/null`）の開始/停止
  - Pod再起動（delete pod）などの故障も選択可能
- **配信ベンチ（実験C/F）**
  - `/render` のTTFB/totalをAPI側で計測（undici + timing）
  - 外部負荷ツール（hey/wrk）の内蔵 or ジョブ実行
- **IBCキュー観測（実験Bの分解の近似）**
  - `ibc channel packet-commitments` 等を定期取得して時系列保存
- **メタデータの完全保存**
  - 実験パラメータ（fragment_size、fdsc台数、負荷条件等）
  - coreのgit commit hash / chart version / image tag

---

## 6. API設計方針（Hono）
### 6.1 基本
- Base path: `/api/v1`
- 返却: JSON（ファイル本体を返す場合のみ `application/octet-stream` 等）
- 認証（最低限）: `Authorization: Bearer <token>`（研究用途でも外部公開を避ける）

### 6.2 長時間処理は「ジョブ化」
uploadや並列実験、スケール、ハッシュ照合は数十秒〜数分かかり得る。

- `POST` は原則 `202 Accepted` で `jobId` を返す
- `GET /api/v1/jobs/{jobId}` で状態取得（`queued/running/succeeded/failed`）
- 完了時、`resultId`（= experimentRunId）に紐づく

### 6.3 タイムアウトと再試行
- 外部HTTP（/render, /manifest, /fragment）: 既定timeoutを持つ（例：10s）
- manifest待ちは最大待機時間（例：5m）を設定し、超過で失敗

---

## 7. 必要な機能をAPIから実行するために必要なAPIエンドポイント
「実験者が触るAPI」と「内部デバッグ向け（必要なら）」を分ける。

### 7.1 Health / Info
- `GET /api/v1/health`
  - 200ならAPIサーバー稼働
- `GET /api/v1/config`
  - 現在のnamespace/service baseなど（秘匿情報は除外）

### 7.2 システム状態（K8s + Core疎通）
- `GET /api/v1/system/status`
  - pods（gwc/mdsc/fdsc*/relayer）とready、再起動回数
  - service疎通（GWC/MDSC/FDSCのHTTP GET）

- `GET /api/v1/system/components`
  - fdscインスタンス一覧（index, instance label, service名）

（必要なら）
- `GET /api/v1/system/logs/{component}`
  - component: `gwc|mdsc|fdsc-0|relayer` 等
  - query: `since=10m&tail=200`

### 7.3 プロジェクト操作（アップロード/取得）
- `POST /api/v1/projects/upload`
  - multipart/form-data
    - `file`: zip or single file
    - fields: `projectName?`, `version?`, `fragmentSize?`, `mode=zip|single`
  - 実装上は gwc pod内で `gwcd tx gateway upload` を実行
  - return: `{ jobId }`

- `GET /api/v1/projects/{projectName}/manifest`
  - MDSCの `/mdsc/metastore/v1/manifest/{project}` をプロキシ（または直接返す）

- `GET /api/v1/projects/{projectName}/render`
  - query: `path`, `version?`
  - GWCの `/render` をプロキシ
  - 研究用途では「ハッシュ照合用に生bytesが欲しい」ため、バイナリ返却を許可

### 7.4 実験実行（A〜F）
- `POST /api/v1/experiments/run`
  - body例:
    - `{ "type": "A", "zipDatasetId": "...", "fragmentSize": 65536 }`
    - `{ "type": "B", "zipDatasetId": "..." }`
    - `{ "type": "F", "zipDatasetId": "...", "concurrency": 10 }`
  - return: `{ jobId }`

- `GET /api/v1/experiments/runs`
  - run一覧（日時、type、主要パラメータ、成功/失敗）

- `GET /api/v1/experiments/runs/{runId}`
  - 結果詳細（E2E、mismatch一覧、ログ抜粋等）

- `GET /api/v1/experiments/runs/{runId}/export?format=json|csv`

### 7.5 観測（fragment数、Tx、TTFB）
- `GET /api/v1/observations/fdsc-fragments`
  - 各FDSCの `count_total` を返す

- `GET /api/v1/observations/tx/{txHash}`
  - height/code/raw_log（gwc query tx）

- `POST /api/v1/observations/render-timing`
  - `{ projectName, path, repeat }` を受け取り、TTFB/totalを計測して返す

### 7.6 障害注入・環境変更（Optional）
- `POST /api/v1/faults/fdsc/{index}/cpu-hog/start`
- `POST /api/v1/faults/fdsc/{index}/cpu-hog/stop`
- `POST /api/v1/system/scale-fdsc`
  - `{ replicas: number }`（Helm upgrade等を内部で実行）

### 7.7 ジョブ
- `GET /api/v1/jobs/{jobId}`
- `GET /api/v1/jobs/{jobId}/logs`（サーバー側の進捗ログ）


---

## 8. 結果管理（保存形式・データモデル）
研究では「後から再計算できる粒度」で保存するのが重要。

### 8.1 保存方針
- 1回の実験実行を **ExperimentRun** として永続化
- 入力（zip/ファイル）は「再現可能な形」で保持
  - 方式例：
    - `datasets/` にzipを保存し、`datasetId` で参照
    - もしくはS3等へ保存（URLとhashを保持）

### 8.2 最小データモデル（例）
- `ExperimentRun`
  - `runId`（UUID）
  - `type`（A/B/C/D/E/F）
  - `createdAt`, `finishedAt`, `status`
  - `params`（JSON: fragmentSize, concurrency, fdscReplicas, slowFdscIndex, timeout 等）
  - `artifacts`（JSON: datasetId, txHashes[], mismatchesPath, logsPath, summaryPath 等）
  - `summary`（JSON: 主要指標の集約）

- `Dataset`
  - `datasetId`
  - `originalName`
  - `sha256`
  - `storedPath`

保存先（例）
- DB: SQLite（単機）/ Postgres（複数人）
- Artifacts: ローカルボリューム or オブジェクトストレージ

---

## 9. 非機能要件
### 9.1 セキュリティ
- APIは原則 **クローズド**（学内ネットワーク/VPNなど）
- Bearer token 等で最低限の認証
- K8s権限は最小化（必要なnamespaceに限定）
- mnemonics等の秘匿値をAPIレスポンスに出さない（`/config` でも除外）

### 9.2 信頼性
- /render / manifest / fragment 取得はtimeout・リトライ（回数上限）を持つ
- manifest待ちは最大待機時間を設定（無限待ち禁止）

### 9.3 観測性
- APIサーバー自身のログ（ジョブ進捗、失敗理由）
- 可能なら Prometheus メトリクス（ジョブ件数、失敗率、外部HTTP時間など）

---

## 10. 実装メモ（TypeScript + Hono）
### 10.1 推奨ライブラリ
- Hono: ルーティング
- zod: 入力バリデーション
- `@kubernetes/client-node`: pod一覧/exec/log/scale
- undici: HTTPクライアント（timeout付きで叩ける）
- SQLite（better-sqlite3 / drizzle等）: 結果保存

### 10.2 upload実装の現実解（CosmJSより簡単）
現行は `MsgUpload` に生データを載せるため、署名・broadcast周りをTSだけで実装すると手間が大きい。
研究用MVPとしては **gwc pod内で `gwcd tx gateway upload` を実行**するのが最短。

実装ステップ（概念）
1) APIがmultipartでzipを受信し、一時ファイルに保存
2) Kubernetes APIで gwc pod にファイル転送（`kubectl cp`相当）
   - 実装案: `tar` ストリーム + `pods/exec` で展開
3) gwc pod内で `gwcd tx gateway upload <filename> @/tmp/<file>` を実行
4) stdoutのjsonから `txhash` を抽出し、runに記録

### 10.3 FDSC/MDSC参照はRESTでよい
- MDSC: `GET /mdsc/metastore/v1/manifest/{project_name}`
- FDSC: `GET /fdsc/datastore/v1/fragment/{fragment_id}` / `GET /fdsc/datastore/v1/fragment`（count_total）

---

## 11. 実験A〜FをAPIで実行するための「機能↔エンドポイント」対応
### 実験A（復元正確性）
- `POST /projects/upload` → `POST /experiments/run (type=A)`
- `GET /projects/{project}/manifest`（内部で利用）
- `GET /projects/{project}/render?path=...`（内部で全ファイルを取得）
- 結果: mismatch一覧、成功率、総ファイル数

### 実験B（アップロード性能）
- `POST /experiments/run (type=B)`
  - upload開始時刻〜manifest可視化までのE2E
  - `GET /observations/tx/{txHash}` でheight/code
  - `GET /system/logs/relayer?since=...` でrelayerログ抜粋

### 実験C（配信性能）
- `POST /observations/render-timing` または `POST /experiments/run (type=C)`
- 結果: ttfb/total（繰り返し回数別の分布）

### 実験D（スケーラビリティ）
- `POST /system/scale-fdsc`（Optional）
- `GET /observations/fdsc-fragments` で格納数偏り
- `POST /experiments/run (type=D)` で「台数×(A/B/C)」のバッチ実行

### 実験E（不均一・混雑）
- `POST /faults/fdsc/{index}/cpu-hog/start`（Optional）
- `POST /experiments/run (type=E)` でB/C相当を比較
- `POST /faults/.../stop` で復旧

### 実験F（同時ユーザー）
- `POST /experiments/run (type=F, concurrency=N)`
- 結果: E2E分布、失敗率、公平性計算用のrawデータ

---

## 将来対応（卒論の説得力を上げる拡張）
- GWC側に計測ログ/メトリクス（zip展開、chunk化、send、ack待ち、manifest送信）を追加し、APIが収集
- IBCのcommitment数・ACK遅延の時系列を標準で保存（B/D/Eの根拠が強くなる）
- /renderのendpoint解決（channel-id→endpoint）を堅牢化し、実験環境変動に強くする
