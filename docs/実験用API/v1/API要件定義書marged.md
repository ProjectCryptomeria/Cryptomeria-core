# API要件定義書（Cryptomeria-BFF v1）統合版

- 対象: Cryptomeria-BFF v1
- 版: 1.0.0（統合版 / Draft）
- 最終更新: 2026-01-23
- 対象リポジトリ:
  - Cryptomeria-core（K8s上で動作するブロックチェーンシステム）
  - Cryptomeria-BFF（coreへアクセスするAPIを提供するBFF）

---

## 0. この要件定義書は何か（位置づけ）

この文書は、Cryptomeria-core（k8s/helm/relayer/chain群） + Cryptomeria-BFF（API化）を対象に、BFFが提供するAPIを **三層（第1層/第2層/第3層）** に分けて要件を定義し、API仕様書（第一層〜第三層）およびジョブ基盤（APIJOB仕様書）へ落とし込むための **要件定義書**である。

- API仕様書：何をどういう形で提供するか（エンドポイント、JSON構造、レスポンスなど）
- 要件定義書（本書）：なぜそれが必要か、何を実現するためか、どんな状態になれば成功か

つまり本書は「仕様書を書く理由」と「仕様書に含めた各要素の最終目的」を言語化し、今後の実装・運用・実験の判断基準を固定するための文書である。

---

## 1. 背景・目的

Cryptomeria-core は Kubernetes 上で動作し、複数チェーン（例: GWC/MDSC/FDSC-*）と relayer によりシステム全体として成立する。  
実験・評価・データ取得を行うには、単に Helm install するだけでは不十分であり、relayer の初期化・接続・起動などの「start-system 相当」手順が必要である。

現状は `just` / shell script / kubectl に運用が分散し、以下の課題がある。

- 起動・接続手順がスクリプトに埋もれており再現性が低い
- Pod/Service/Port の確認が手動で、状況把握に時間がかかる
- Tx送信/観測/負荷試験に必要なツールが散在し、実験の自動化が難しい
- 実験のログ（状態スナップショット、計測結果）が統一形式で残らない

本要件定義書は、これらを解決するために Cryptomeria-BFF の提供する API を **三層**に分け、API仕様書（第一層〜第三層）およびジョブ基盤（APIJOB仕様書）へと落とし込む。

### 1.1 最終目的（ゴール）

Cryptomeria-coreの実験・運用において、これまで人手で行っていた以下を **BFF経由のAPI呼び出しだけで再現可能にする**ことがゴールである。

- k8s上で cryptomeria を導入し（helm）
- システムを “実験可能状態” に初期化して（relayer init / IBC connect / relayer start）
- 状態を確認し（pods/services/ports/chain status）
- チェーンに対して操作や観測を行い（Tx送信、ブロック観測など）
- 実験に必要な測定・集計・負荷投入を回し（latency/TPS/バッチ）
- 最後に環境を破棄・クリーンに戻す（uninstall/clean）

この結果として、実験の手順や運用の手順は **(a) 再現可能**で、**(b) 自動化しやすく**、**(c) 失敗時の原因が追える**ものになることを狙っている。

> 注記（v1の範囲）  
> v1では「既にインストール済みの cryptomeria に対して start/connect を行う」ことに集中する。  
> Helm install/uninstall/upgrade/deploy/clean を BFF から実行する機能は v1 のスコープ外とする（将来拡張候補）。

### 1.2 直接の課題（現状の痛点）

1) **起動手順が「helmだけでは完結しない」**  
   cryptomeriaは helm install の後に、relayer init / connect / start が必要で、現状は `just start-system` や shell/kubectl exec に依存している。  
   → 実験者が毎回手順を再現する必要があり、ミス・抜け・環境差が出やすい。

2) **状態確認が散らばっている**  
   pod確認、service/port確認、relayerログ、チェーンstatusなどが `kubectl` / curl / just に分散。  
   → “今どこが悪いか” が分かりづらい。特に失敗時の切り分けが重い。

3) **実験の測定・集計がクライアント実装に寄りすぎる**  
   ブロック時間、Tx確認時間、TPS近似など、実験で必要な値が「その場のスクリプト」に埋め込まれやすい。  
   → 再実験や比較が難しく、再現性が落ちる。

4) **スケール・再接続が面倒**  
   fdscを増やすたびに helm upgrade → relayer再起動 → 接続再整備が必要。  
   → ルーチンなのに人手が介在してコストが高い。

これらを根本的に解消するには、単に「チェーンを叩けるAPI」だけでは不十分で、**k8s運用・接続手順・測定集計までをAPIとして固定する**必要がある。

---

## 2. スコープ

### 2.1 スコープ内（v1）

以下を **HTTP API** として提供する。

#### (A) 第一層: System / K8s 操作・観測
- K8s 上の cryptomeria システムの状態を要約して取得できること（kubectl不要）
- relayer 初期化・接続・起動（start-system相当）を BFF 経由で実行できること
- 長時間処理は **非同期ジョブ**で実行し、進捗・ログを追跡できること

#### (B) 第二層: Blockchain（チェーン操作）
- チェーン一覧を **Pod起点**で取得できること
- Tx送信（simulate/broadcast）と、主要な照会（status, tx, blocks, accounts）を提供すること
- ブロック時間（blocktime）を **ブロックヘッダ時刻ベース**で計測し、windowキャッシュを持つこと

#### (C) 第三層: Utilities（実験・データ取得・負荷）
- 観測（tx confirmation wait, batch）
- メトリクス（throughput/TPS近似）
- 負荷（署名済Txの並列broadcast、broadcast+confirm）
- 実験ログ向けスナップショット（k8s+chain）
- 上記を原則 **ジョブ化**して追跡可能にする

#### (D) APIJOB: ジョブ基盤の共通化
- System/Utilities 両方で使えるジョブモデル・ログ・キャンセル・排他を共通仕様として定義する

### 2.2 スコープ外（v1）

以下は v1 では提供しない（手動運用または将来拡張）。

- Helm install/uninstall/upgrade/deploy/clean を BFF から実行する機能  
  - v1は「**既にインストール済みの cryptomeria** に対して start/connect を行う」ことに集中する
- Docker build / push / minikube load 等のビルド・配布
- WebSocket 等のリアルタイムストリーミング
- ジョブ永続化（DB等の不揮発ストレージ）
- 署名生成（BFFは署名済 TxBytes の受け口）
- BFF側での認証・権限・管理者トークン等は扱わない（要件から撤廃）
- ブロックチェーン研究上の新規機能（プロトコル変更等）は本要件外  
  本要件は “運用・実験・観測のAPI化” にフォーカスする
- 実験シナリオ実行（`/utils/experiments/run`）は将来枠であり、必須ではない（必要になった段階で具体化）

---

## 3. 三層アーキテクチャ（要求）

仕様書を3層に分けたのは、要件が混ざると “責務が曖昧になって破綻する” からである。

- 第1層：環境・運用（k8s/exec） → “実験可能状態を作る”
- 第2層：チェーン内部（RPC/REST/gRPC） → “観測とTx操作”
- 第3層：実験ユースケース（測定・集計・負荷） → “実験を回す”

### 3.1 第一層（System / K8s）

目的: システム全体の稼働・接続を操作し、運用・実験の前提を整える。

必須要件:
- `/system/status` で Pod/Relayer/Chains の要約が取得できる
- `/system/topology` で chain pod と service/port の対応が確認できる
- `/system/preflight` で `/system/start` の前提が整っているかが説明付きで分かる
- `/system/start` で start-system 相当（init/connect/start）を **ジョブ実行**できる
- `/system/connect` で接続のみを再実行できる

性能・安定性:
- K8s API 不達時は 503 を返し、原因を識別できる
- system操作ジョブは同時実行を抑制（排他）し、二重実行事故を防ぐ

第1層がもたらすべき価値は、
- **人手手順（just/shell/kubectl）をAPIに置き換える**
- **“起動済み” ではなく “実験可能” を作る**
- **失敗をログとステップで説明できる**
である。

### 3.2 第二層（Blockchain）

目的: チェーン内部の処理（照会/Tx送信/観測）を提供する。

必須要件:
- `/chains` で Pod 起点のチェーン一覧を返す
- `/chains/{chainId}/simulate` と `/broadcast` を提供する
- `blocks`, `tx`, `accounts`, `status`, `mempool` の取得ができる
- `blocktime` を window 指定で計測できる
- `blocktime` は window キャッシュを用い、同一 latestHeight なら再計算を回避する

計測定義:
- blocktime はブロックヘッダ時刻を用いる（wall-clockは使わない）

第2層がもたらすべき価値は、
- **実験コードが「どのチェーンのどこに接続すべきか」を迷わない**
- **観測・Tx操作が統一された形で提供される**
- **実験指標（blocktime等）を取れる土台を作る**
である。

### 3.3 第三層（Utilities）

目的: 実験・負荷・観測のユーティリティを提供する。

必須要件:
- tx confirmation wait（単発/バッチ）を提供する
- throughput/TPS 近似を提供し、定義を固定する
- 署名済Txの broadcast-batch を提供し、並列上限をサーバ側で強制する
- broadcast+confirm を提供し、負荷＋観測を統合できる
- resource-snapshot を提供し、実験ログ添付を容易にする
- 上記は原則ジョブ化し、進捗・ログを追跡できる

TPS/throughput 固定定義:
- endHeight = latestHeight
- startHeight = endHeight - window + 1
- totalTx = Σ txCount[h] for h in [startHeight..endHeight]
- durationSeconds = (headerTime[endHeight] - headerTime[startHeight]).seconds
- tps = totalTx / durationSeconds

第3層がもたらすべき価値は、
- **実験ロジックの共通化（測定・集計・負荷投入）**
- **再現性の高い実験結果（スナップショット付与）**
- **比較可能な指標の提供（latency/TPS/blocktime）**
である。

---

## 4. 成功条件（Success Conditions）と受け入れ基準（Acceptance Criteria）

### 4.1 第一層（System/K8s）

成功条件:
**A. 実験可能状態を作れる**
- helm install 済みの環境に対して `POST /system/start` を叩けば、
  - relayer init
  - connect-all（IBC linkや登録）
  - relayer start
  - IBC ready の確認  
  が “ジョブとして” 進み、完了状態（succeeded/failed）が残る。

**B. 失敗を説明できる**
- `GET /system/jobs/{jobId}` で、どのステップで失敗したかが分かる。
- `GET /system/jobs/{jobId}/logs` で、実行コマンドと出力が追える。

**C. 状態を一括で確認できる**
- `GET /system/status` と `GET /system/ports` により、
  - どのPod/Service/portで何が動いているか
  - relayerは動いているか
  - チェーンは動いているか  
  が “kubectlなしで” 分かる。

受け入れ基準:
- Helm install 済み環境で `/system/preflight` が overallOk=true を返す
- `/system/start` 実行でジョブが作成され、完了後に relayer が稼働し、チェーン間接続が成立する
- `/system/status` が Ready/NotReady を適切に要約し、relayer稼働有無が分かる

> 第1層の最終価値：  
> **“cryptomeriaを動かせる人” を増やす。手順をAPIに閉じ込め、実験準備を高速化する。**

### 4.2 第二層（Blockchain）

成功条件:
**A. チェーン発見と接続先解決ができる**
- `GET /chains` で chainIdとendpointsが取れるため、環境ごとの接続先差を吸収できる。

**B. 観測と操作が最低限揃っている**
- status/info/block/tx/account/balance が取れる
- simulate/broadcast ができる

**C. 卒研・実験のための観測が取れる**
- `blocktime` と `blocks/{h}/txs` があり、blocktime/TPS等の算出が可能。

受け入れ基準:
- `/chains` が Pod 起点で chainId 一覧を返す
- simulate/broadcast/tx/blocks/accounts/status が期待通り取得できる
- `blocktime` が固定定義で算出され、windowキャッシュが効く（同一latestHeightなら cached=true）

> 第2層の最終価値：  
> **実験が「チェーンに対する統一されたAPI」を前提に書けるようになる。**

### 4.3 第三層（Utilities）

成功条件:
**A. 実験でよく使う“手順”がAPI化されている**
- confirmation待ち、latency統計、broadcastバッチ、confirmバッチが揃う。

**B. 指標が比較可能な形で返る**
- mean/p50/p95などの統計が統一フォーマットで返る。
- throughput（TPS近似）が安定して取得できる。

**C. 実験結果に“状況証拠”が付く**
- `resource-snapshot` を実験ログに添付できることで、後から
  - どんな構成で
  - どんな状態だったか  
  を説明できる。

受け入れ基準:
- tx confirmation（単発/バッチ）が timeout まで待機し、成功時に latencyMs を返す
- throughput が固定定義に従い、必要な根拠フィールドを返す
- broadcast-batch が maxConcurrency/maxBatchSize を守りつつ実行され、成功率・エラーが集計される
- resource-snapshot が system+chain の状態をまとめて返す

> 第3層の最終価値：  
> **測定・集計の実装を毎回作らずに済み、実験結果の再現性と比較可能性が上がる。**

### 4.4 APIJOB（共通ジョブ基盤）

受け入れ基準:
- System/Utils どちらでもジョブが作成・参照・ログ取得・キャンセルできる
- BFF再起動でジョブ一覧がクリアされる（仕様通り）

---

## 5. 非機能要件（NFR）

### 5.1 冪等性（再実行可能性）
- 第一層の system 操作は force=false をデフォルトとし、状態に基づく skip を行う
- 第1層のstart/connect/scaleは、途中失敗後に再実行できる必要がある。
- BFF 再起動によりジョブが消えても、再実行で “済んでいる処理” は極力スキップされる

### 5.2 ジョブ管理（揮発）
- ジョブはインメモリで管理され、BFF 再起動時に消える
- 進捗・ステップ・ログ・キャンセルが提供される
- キャンセルは best-effort（ロールバックは行わない）

### 5.3 排他制御
- 第一層の system 操作ジョブ（system.*）は同時に1つまで（runningがあれば409）
- 第三層は並列実行を許容するが、maxRunningJobs 等の上限で 429 を返す

### 5.4 レート制限・上限／負荷制御（安全運用）
- Utilities層の並列系（broadcast/confirm）は concurrency 上限をサーバ側で必ず持つ。
- Utilities層の batch/負荷系はサーバ側で
  - maxConcurrency
  - maxBatchSize
  を必ず制限する
- blocktime/throughput等の重い観測は window 上限やキャッシュを持つ。

### 5.5 進捗とログ（可観測性）
- ジョブはステップ単位の状態を持つこと（queued/running/succeeded/failed）
- ログは「何を実行し、何が返ったか」が追える形式で保持すること
- 各ジョブに対しログを取得できる（BFFが実行した手順のログ）
- relayer/chain のログは第1層 `/system/k8s/logs` で参照できる

### 5.6 可観測性（運用）
- 失敗時に「何が足りないか」を `/system/preflight` 等で説明できる
- 状態スナップショット（resource-snapshot）により実験の再現性が高まる

### 5.7 再現性（実験の品質）
- snapshotで環境状態を残せること
- 指標計算（blocktime/latency/TPS）が “いつも同じ定義” で算出されること

### 5.8 エラー（識別）
- K8s API 不達時は 503 を返し、原因を識別できる
- 上流不達は 503、上流エラーは 502 で返す（識別）

### 5.9 セキュリティ（前提）
- v1は閉域・研究用途を前提とし、アプリ層認証は必須としない
- 代替としてネットワーク到達制御を推奨する
- 将来の token 認証導入を妨げない設計とする

---

## 6. 仕様策定方針（なぜこう設計するか）

### 6.1 3層分離の意義
- 第1層：環境・運用（k8s/exec） → “実験可能状態を作る”
- 第2層：チェーン内部（RPC/REST/gRPC） → “観測とTx操作”
- 第3層：実験ユースケース（測定・集計・負荷） → “実験を回す”

この分離により、
- 変更の影響範囲が限定される（k8s変更がTx APIに直撃しない）
- 実装と運用が整理される（責務の混線を防ぐ）
- 実験コード側が依存するAPIが安定する（Utilitiesの返却が固定される）

### 6.2 「仕様は長くなるほど価値がある」部分と「分割する」理由
- JSON構造やレスポンス、エラー、パラメータ範囲は、実装と実験の “ズレ” を減らすために詳細化が必要。
- しかし全層を1つの文書にすると追えなくなる。  
  → 層ごとに仕様書を分割し、本書（要件定義書）で目的と整合性を担保する。

---

## 7. 依存・外部インターフェース

### 7.1 Kubernetes API
- BFF はクラスタ外から Kubernetes API にアクセスする
- 必要 RBAC は chart により作成される（pods/exec/log/services/endpoints 等）

### 7.2 Chain RPC / REST
- BFF は chain の RPC/REST にアクセスする
- endpoint 解決は env 固定または K8s discovery により行う

---

## 8. 本要件が満たされたときに得られる最終成果

この要件を満たすと、最終的に次が実現できる。

1) **実験準備がAPIで固定化され、手順ミスが減る**
2) **環境差（接続先、NodePortなど）をBFFが吸収する**
3) **失敗時に “どこで何が起きたか” がジョブで追える**
4) **測定値が統一定義で取得でき、比較可能な実験ができる**
5) **実験ログに状態スナップショットを残せ、再現性が上がる**

---

## 9. 将来拡張（v2以降の候補）

- Helm install/uninstall を Job 方式等で安全に取り込む
- WebSocket/イベント配信
- ジョブ永続化（DB/オブジェクトストレージ）
- 認証（token/role分離）
- 署名補助（signDoc素材生成など）

---

## 10. 変更履歴
- 1.0.0: v1 初版（3層＋ジョブ基盤、helm操作はスコープ外、TPS/throughput固定定義）
