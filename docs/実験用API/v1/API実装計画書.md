# 実装計画書（Cryptomeria-BFF v1）

最終更新: 2026-01-23  
対象: Cryptomeria-BFF（既存実装 + 仕様書/要件定義書/Job仕様書に基づく拡張）

---

## 0. 前提・スコープ（確定事項）

- **BFFはクラスタ外で動作**し、`kubeconfig` 等で Kubernetes API に接続する。:contentReference[oaicite:0]{index=0}
- **helm install/uninstall/upgrade/deploy/clean をBFFが実行する機能は v1スコープ外**。BFFは「インストール済みのシステムに対して start/connect を行う」に集中する。:contentReference[oaicite:1]{index=1}
- **ジョブ永続化はしない（インメモリ）**。BFF再起動でジョブは消える。:contentReference[oaicite:2]{index=2}
- 再起動影響を抑えるため、**force=false時の冪等判定（状態に基づくskip）を基本機能として組み込む**。:contentReference[oaicite:3]{index=3}
- System操作ジョブ（`system.*`）は **同時に1つまで（排他）**。:contentReference[oaicite:4]{index=4}
- Utilities層は並列を許容しつつ、**maxRunningJobs / maxConcurrency / maxBatchSize 等で 429 制御**。:contentReference[oaicite:5]{index=5}
- 第3層の throughput/TPS は **ブロックヘッダ時刻ベース**で統一定義。:contentReference[oaicite:6]{index=6}
- blocktime は固定定義で算出し、**windowキャッシュが効く（同一latestHeightなら cached=true）**。:contentReference[oaicite:7]{index=7}
- 認証・権限・ADMIN等の概念は v1 要件から撤廃（閉域前提）。:contentReference[oaicite:8]{index=8}

---

## 1. 現状実装（BFF）とギャップ整理（要点）

### 1.1 既存BFFの主な実装済み領域
- `/api/v1/chains` 系（チェーン一覧、blocks、tx、accounts 等）
- K8s Service（NodePort）を参照する `K8sManager`、チェーン操作の `CryptomeriaManager`

### 1.2 仕様書から見た主なギャップ
1) **第1層（System/K8s）**
- `/api/v1/system` 配下の API（status/preflight/topology/ports/k8sリソース閲覧）が未整備
- `/system/start`（start-system 相当）を **ジョブ**で実行し、ログ/進捗を追跡する仕組みが必要:contentReference[oaicite:9]{index=9}
- relayer pod への `pods/exec`、`pods/log` を使った **運用手順API化**（kubectl/just依存の置き換え）が必要:contentReference[oaicite:10]{index=10}

2) **第2層（Blockchain）**
- `mode=external|internal|auto`、endpoint解決（env固定 or k8s discovery）の統一実装が必要:contentReference[oaicite:11]{index=11}
- `blocktime` の **windowキャッシュ**と `cached` フィールド整備が必要:contentReference[oaicite:12]{index=12}

3) **第3層（Utilities）**
- 長時間/高負荷は **非同期ジョブ化**（Utilitiesスコープ）:contentReference[oaicite:13]{index=13}
- throughput 定義固定（ヘッダ時刻ベース）:contentReference[oaicite:14]{index=14}
- resource-snapshot 等「状況証拠」を残す API を実装する（要件の成功条件）:contentReference[oaicite:15]{index=15}

---

## 2. 実装方針（アーキテクチャ）

### 2.1 三層分離の実装構造
- `routes/system/*`（第1層）: k8s/exec/log/運用ジョブ
- `routes/chains/*`（第2層）: chain API（RPC/REST）
- `routes/utils/*`（第3層）: 集計・負荷・測定（Job化）

要件の三層意義に沿って責務を分離し、k8s運用変更がTx APIに波及しない構造にする。:contentReference[oaicite:16]{index=16}

### 2.2 共通基盤（Cross-cutting）
- **エラー形式の統一**（最低限：仕様書の `error:{code,message,details}` 形式に揃える）:contentReference[oaicite:17]{index=17}
- **ジョブ基盤（APIJOB仕様書準拠）**を system/utils 両スコープで共用:contentReference[oaicite:18]{index=18}
- **機密除外**（kubeconfig/token/mnemonic/txBytes生データ等を logs/request/details に出さない）:contentReference[oaicite:19]{index=19}
- **上限/負荷制御**（system排他、utils上限、blocktime/throughput window 上限+キャッシュ）:contentReference[oaicite:20]{index=20}

---

## 3. マイルストーン（段階的リリース）

### M0: 下準備（リファクタ最小）
- 既存 routes/managers の影響範囲を最小化して拡張できるようにする
- `Config`（namespace、nodeHost、timeouts、limits）を集約
- 共通 Error/Response ヘルパー導入（後述）

成果物: ビルド/起動が壊れない状態で基盤追加可能

---

### M1: ジョブ基盤（APIJOB）を実装（System/Utils共用）
要件: system/utils 両方で job が作成・参照・ログ取得・キャンセルできる:contentReference[oaicite:21]{index=21}

#### 作業項目
1. `JobStatus/StepStatus` と `Job` データモデル実装:contentReference[oaicite:22]{index=22}  
2. `InMemoryJobStore`（揮発、ログ上限、リングバッファ or 末尾打ち切り）:contentReference[oaicite:23]{index=23}  
3. `JobRunner`（キュー/並列/排他/キャンセル/timeoutMs）  
   - ジョブ全体タイムアウトの扱い（期限超過→failed + TIMEOUT）:contentReference[oaicite:24]{index=24}  
   - キャンセル（best-effort、abortSignalでステップが定期確認）:contentReference[oaicite:25]{index=25}  
4. scope別の job API ルータ（`/api/v1/{scope}/jobs...`）  
   - `GET /jobs`, `GET /jobs/{jobId}`, `GET /jobs/{jobId}/logs`, `POST /jobs/{jobId}/cancel` :contentReference[oaicite:26]{index=26}

成果物: Job API が単体で動作（ダミージョブで確認可能）

---

### M2: 第1層 K8s観測API（read系）を実装
目的: kubectl無しで状態把握を可能にする（要件）:contentReference[oaicite:27]{index=27}

#### 追加/拡張するK8s基盤（K8sManager拡張）
- `pods/list`：label selector/phase/ready/containers など
- `services/list`：type/ports/selector 等
- `endpoints/list`：subsets（addresses/ports）
- `configmaps/list`：metadata + keys（dataは原則返さない）
- `logs/get`：pod指定 + tail/sinceSeconds（text/plain）:contentReference[oaicite:28]{index=28}  
- `exec`：relayer操作用（後続のM3で利用）

#### 実装するSystemエンドポイント（read系）
- `GET /system/status`（pods/relayer/chains の要約）:contentReference[oaicite:29]{index=29}  
- `GET /system/topology`（chain pod と service/port 対応）:contentReference[oaicite:30]{index=30}  
- `GET /system/ports`（NodePort/ClusterIP等のポート一覧）  
- `GET /system/preflight`（/start前提チェック、説明付き）:contentReference[oaicite:31]{index=31}  
- `GET /system/k8s/*`（pods/services/endpoints/configmaps/logs）

成果物: 「どのPod/Service/portで何が動いているか」がAPIで確認できる状態:contentReference[oaicite:32]{index=32}

---

### M3: 第1層 運用ジョブ（start/connect/relayer restart）を実装
目的: `just start-system` 相当の手順を API化し、非同期ジョブで追跡可能にする:contentReference[oaicite:33]{index=33}

#### 対象エンドポイント
- `POST /system/start` → type=`system.start`（202 Accepted）:contentReference[oaicite:34]{index=34}  
- `POST /system/connect` → type=`system.connect`（target=all or chain:<id>）:contentReference[oaicite:35]{index=35}  
- `POST /system/relayer/restart`（任意）:contentReference[oaicite:36]{index=36}  

#### Systemジョブのtype/step（仕様準拠）
- type 一覧: `system.start`, `system.connect`, `system.relayer.restart`:contentReference[oaicite:37]{index=37}  
- `system.start` steps: discover → initRelayer → connectAll → startRelayer → waitReady(任意):contentReference[oaicite:38]{index=38}  
- 冪等判定（force=false）: initRelayer/connectAll/startRelayer/waitReady で skip 条件を実装:contentReference[oaicite:39]{index=39}  

#### 実装詳細（Relayer/Chain操作）
- **discover**
  - Namespace既定 `cryptomeria`（envで変更可能）:contentReference[oaicite:40]{index=40}  
  - relayer pod 同定: label selector優先 `app.kubernetes.io/component=relayer`、fallbackは名前prefix等:contentReference[oaicite:41]{index=41}  
  - chain pod 一覧（`app.kubernetes.io/instance` を chainId として利用）

- **initRelayer（coreの init-relayer.sh 相当）**:contentReference[oaicite:42]{index=42}  
  - relayer pod へ exec し、以下を冪等に整備:
    - config init（既に存在すれば skip）
    - chain定義（不足分のみ add）
    - relayer keys（chainごとに存在確認→restore）
  - 注意: mnemonic/secretは logs に出さない（件数・対象chainIdのみ）:contentReference[oaicite:43]{index=43}

- **connectAll（coreの connect-all.sh / connect-chain.sh 相当）**:contentReference[oaicite:44]{index=44}  
  - target=`all` の場合、gwc と各チェーンを接続
  - target=`chain:<id>` の場合、指定chainのみ接続
  - 冪等:
    - 既存 channel/connection があれば対象ペアを skip:contentReference[oaicite:45]{index=45}  
    - 既登録（GWC storage登録等）なら skip:contentReference[oaicite:46]{index=46}  
  - リトライ:
    - link は一定回数リトライ（script相当の 5回/10秒等）を実装
  - 失敗時:
    - `RELAYER_LINK_FAILED` 等の code を付け、details に chainPair/hint を入れる例に合わせる:contentReference[oaicite:47]{index=47}

- **startRelayer（coreの start-relayer.sh 相当）**:contentReference[oaicite:48]{index=48}  
  - `rly` プロセス稼働判定（稼働中なら skip or restart専用ジョブへ誘導）:contentReference[oaicite:49]{index=49}  
  - 起動はバックグラウンド実行 + 起動確認（pgrep 等）

- **waitReady / waitIbcReady（任意）**
  - IBC接続確認（channels/paths/疎通チェック）を短時間で行い、timeoutSeconds内で終える

#### 排他（system.*）
- 既に running の system.* があれば 409 Conflict を返す:contentReference[oaicite:50]{index=50}

成果物: helm install 後に `/system/start` で実験可能状態まで持っていける（kubectl/just不要）:contentReference[oaicite:51]{index=51}

---

### M4: 第2層（Blockchain）仕様差分を埋めて安定化
目的: 実験クライアントが「統一API」を前提に書ける状態にする:contentReference[oaicite:52]{index=52}

#### 作業項目
1) `/chains` を **pod起点で列挙**（chainId = `app.kubernetes.io/instance`）:contentReference[oaicite:53]{index=53}  
2) endpoint解決
- env固定 or K8s discovery（NodePort/ClusterIP）:contentReference[oaicite:54]{index=54}  
- `mode=external|internal|auto` を統一実装:contentReference[oaicite:55]{index=55}  
3) `blocktime` 実装
- fixed定義 + window 上限 + **windowキャッシュ（same latestHeightなら cached=true）**:contentReference[oaicite:56]{index=56}  
- キャッシュキー（例）:
  - `(chainId, windowBlocks, mode, percentiles...)`
  - 保存値: `latestHeightUsed`, `computedAt`, `result`, `cached=false/true`
4) エラー分類（上流不達 503 / 上流エラー 502 など識別）:contentReference[oaicite:57]{index=57}

成果物: 第2層の受け入れ基準を満たす（/chains, simulate/broadcast, status/info/block/tx/account, blocktime cache）:contentReference[oaicite:58]{index=58}

---

### M5: 第3層（Utilities）ジョブ化 + 実験ユースケース整備
目的: 実験の「測る・まとめる・流す・記録する」をBFFに集約し、再現性と比較可能性を上げる:contentReference[oaicite:59]{index=59}

#### 方針
- 長時間/高負荷になり得る処理は **非同期ジョブ化**:contentReference[oaicite:60]{index=60}  
- throughput は **ブロックヘッダ時刻ベース**で固定:contentReference[oaicite:61]{index=61}  
- limits（maxRunningJobs/maxConcurrency/maxBatchSize）で安全運用:contentReference[oaicite:62]{index=62}  

#### 主要ユースケース（要件成功条件）
- confirmation待ち、latency統計、broadcastバッチ、confirmバッチ:contentReference[oaicite:63]{index=63}  
- throughput（安定取得）:contentReference[oaicite:64]{index=64}  
- resource-snapshot（状況証拠）:contentReference[oaicite:65]{index=65}  

#### 実装タスク（例：ジョブtype/stepは第三層仕様に合わせて確定）
- `utils.observe.tx-confirmation`（単発）
- `utils.observe.confirm-batch`（バッチ）
- `utils.metrics.throughput`（ヘッダ時刻ベース固定）
- `utils.load.broadcast-batch`（concurrency制御、集計）
- `utils.snapshot.resource`（system + chains をまとめる）

#### throughput（ヘッダ時刻ベース）の実装メモ
- height範囲を明示し、以下を result に含める（比較可能性の核）
  - `fromHeight`, `toHeight`, `includedBlocks`
  - `fromHeaderTime`, `toHeaderTime`
  - `durationSeconds = toHeaderTime - fromHeaderTime`
  - `txCount`（範囲内 tx 合計）
  - `tps = txCount / durationSeconds`
- ブロック取得は window 上限を設け、必要ならキャッシュ（blocktime同様）も検討:contentReference[oaicite:66]{index=66}

成果物: 第3層の受け入れ基準を満たす（confirmation/throughput/broadcast-batch/snapshot）:contentReference[oaicite:67]{index=67}

---

## 4. 具体的な実装構成（提案）

### 4.1 ディレクトリ案
- `src/`
  - `app.ts`（Hono初期化、/api/v1 mount）
  - `routes/`
    - `system.ts`（/api/v1/system）
    - `chains.ts`（/api/v1/chains：既存を整理）
    - `utils.ts`（/api/v1/utils）
  - `managers/`
    - `k8s-manager.ts`（list/log/exec/endpoints/configmaps 拡張）
    - `cryptomeria-manager.ts`（第2層）
    - `system-manager.ts`（relayerワークフロー: discover/init/connect/start）
  - `jobs/`
    - `job-manager.ts`（enqueue/run/cancel）
    - `job-store.ts`（in-memory store）
    - `job-logger.ts`（append-only + 上限）
    - `types.ts`（Job/Step/Error）
  - `lib/`
    - `errors.ts`（error code + mapper）
    - `http.ts`（response envelope）
    - `limits.ts`（maxRunningJobs/maxConcurrency/maxBatchSize）
    - `time.ts`（ISO/UTC）
  - `cache/`
    - `blocktime-cache.ts`

### 4.2 共通レスポンス戦略
- System read系は `{ ok:true, data:... }` に寄せる（System仕様）:contentReference[oaicite:68]{index=68}
- job create は `202 Accepted` + jobId 即時返却:contentReference[oaicite:69]{index=69}
- error は `{ error:{code,message,details} }` を基本にする（新仕様寄り）:contentReference[oaicite:70]{index=70}  
  - 既存互換が必要なら `{ok:false,error:...}` へのラップは後で追加可能（v1では仕様優先）

---

## 5. テスト計画

### 5.1 Unit Test（最優先）
- JobRunner
  - status遷移（queued→running→succeeded/failed/canceled）:contentReference[oaicite:71]{index=71}
  - step遷移（pending/running/skipped...）
  - timeoutMs（期限超過で failed + TIMEOUT）:contentReference[oaicite:72]{index=72}
  - cancel（best-effort、以降stepに進まない）:contentReference[oaicite:73]{index=73}
  - log上限（例 5MB/ジョブ）:contentReference[oaicite:74]{index=74}
- blocktime cache
  - 同一latestHeightで cached=true になる:contentReference[oaicite:75]{index=75}

### 5.2 Integration Test（minikube/kind）
- `/system/preflight` が不足条件を説明できる:contentReference[oaicite:76]{index=76}
- `/system/start`（force=false）を2回叩くと2回目は多くが skipped になる（冪等性）:contentReference[oaicite:77]{index=77}
- `/system/connect` target=chain で部分再実行できる:contentReference[oaicite:78]{index=78}
- `/utils/snapshot/resource` が system+chains をまとめて返す:contentReference[oaicite:79]{index=79}

---

## 6. 運用・リリース手順（v1）

1) helm install（手動・従来通り）:contentReference[oaicite:80]{index=80}  
2) BFF起動（クラスタ外、kubeconfig設定）:contentReference[oaicite:81]{index=81}  
3) `/system/preflight` で前提確認  
4) `/system/start` を叩いてジョブ監視（/system/jobs/{id}, logs）:contentReference[oaicite:82]{index=82}  
5) 実験クライアントは `/chains` → `/utils/*` を利用

---

## 7. 主要リスクと対策

### 7.1 relayer操作（pods/exec）の不安定性
- 原因: RBAC不足、Pod再生成、execのストリーム切断
- 対策:
  - `/system/preflight` で「exec可能か」を明示し、失敗原因を返す:contentReference[oaicite:83]{index=83}
  - execは短いコマンド単位に分割し、リトライ可能にする
  - ジョブのログに「実行したコマンド要約」を残す（機密除外）:contentReference[oaicite:84]{index=84}

### 7.2 BFF再起動でジョブが消える
- 仕様通りだが、運用で混乱しやすい
- 対策:
  - `/system/start` の冪等skipを徹底し、再実行で復帰できるようにする:contentReference[oaicite:85]{index=85}
  - jobId消失（404）を明確に返す:contentReference[oaicite:86]{index=86}

### 7.3 定義ブレ（throughput/TPS、blocktime）
- 対策:
  - throughputはヘッダ時刻ベースに固定し、根拠フィールド（height/time範囲）を返す:contentReference[oaicite:87]{index=87}
  - blocktimeはwindowキャッシュ + 上限で安定運用:contentReference[oaicite:88]{index=88}

---

## 8. 実装順序（依存関係まとめ）

1. **M1 Job基盤**（以降のsystem/utilsは全て依存）:contentReference[oaicite:89]{index=89}  
2. **M2 K8s read系**（system status/preflight、後でstartが依存）:contentReference[oaicite:90]{index=90}  
3. **M3 system start/connect**（exec実装 + 排他 + 冪等）:contentReference[oaicite:91]{index=91}  
4. **M4 blockchain blocktime cache + endpoints解決**:contentReference[oaicite:92]{index=92}  
5. **M5 utilities job化（throughput/snapshot/load）**:contentReference[oaicite:93]{index=93}  

---

## 9. 完了条件（Definition of Done）

- 第1層:
  - `/system/status`, `/system/ports`, `/system/preflight` が動く:contentReference[oaicite:94]{index=94}
  - `/system/start` が 202 を返し、job追跡/ログ取得/キャンセルできる:contentReference[oaicite:95]{index=95}
  - system.* 同時実行が抑制される（409）:contentReference[oaicite:96]{index=96}

- 第2層:
  - `/chains` が pod起点で列挙し、modeに応じたendpoint解決ができる:contentReference[oaicite:97]{index=97}
  - `blocktime` が cached=true を返せる（同一latestHeight）:contentReference[oaicite:98]{index=98}

- 第3層:
  - confirmation/batch/load/throughput/snapshot の主要ユースケースが揃う:contentReference[oaicite:99]{index=99}
  - throughput がヘッダ時刻ベース固定定義で根拠付きで返る:contentReference[oaicite:100]{index=100}
  - utilitiesジョブは上限を守り、429で安全に拒否できる:contentReference[oaicite:101]{index=101}

---
