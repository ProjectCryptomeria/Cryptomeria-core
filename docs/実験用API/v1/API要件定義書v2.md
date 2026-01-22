# API要件定義書（Cryptomeria-BFF v1）

- 対象: Cryptomeria-BFF v1
- 版: 1.0.0
- 最終更新: 2026-01-23
- 対象リポジトリ:
  - Cryptomeria-core（K8s上で動作するブロックチェーンシステム）
  - Cryptomeria-BFF（coreへアクセスするAPIを提供するBFF）

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

---

### 2.2 スコープ外（v1）
以下は v1 では提供しない（手動運用または将来拡張）。

- Helm install/uninstall/upgrade/deploy/clean を BFF から実行する機能  
  - v1は「**既にインストール済みの cryptomeria** に対して start/connect を行う」ことに集中する
- Docker build / push / minikube load 等のビルド・配布
- WebSocket 等のリアルタイムストリーミング
- ジョブ永続化（DB等の不揮発ストレージ）
- 署名生成（BFFは署名済 TxBytes の受け口）

---

## 3. 三層アーキテクチャ（要求）

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

---

## 4. 非機能要件（NFR）

### 4.1 冪等性
- 第一層の system 操作は force=false をデフォルトとし、状態に基づく skip を行う
- BFF 再起動によりジョブが消えても、再実行で “済んでいる処理” は極力スキップされる

### 4.2 ジョブ管理（揮発）
- ジョブはインメモリで管理され、BFF 再起動時に消える
- 進捗・ステップ・ログ・キャンセルが提供される
- キャンセルは best-effort（ロールバックは行わない）

### 4.3 排他制御
- 第一層の system 操作ジョブ（system.*）は同時に1つまで（runningがあれば409）
- 第三層は並列実行を許容するが、maxRunningJobs 等の上限で 429 を返す

### 4.4 レート制限・上限
- Utilities層の batch/負荷系はサーバ側で
  - maxConcurrency
  - maxBatchSize
  を必ず制限する

### 4.5 ログ
- 各ジョブに対しログを取得できる（BFFが実行した手順のログ）
- relayer/chain のログは第1層 `/system/k8s/logs` で参照できる

### 4.6 可観測性（運用）
- 失敗時に「何が足りないか」を `/system/preflight` 等で説明できる
- 状態スナップショット（resource-snapshot）により実験の再現性が高まる

### 4.7 セキュリティ（前提）
- v1は閉域・研究用途を前提とし、アプリ層認証は必須としない
- 代替としてネットワーク到達制御を推奨する
- 将来の token 認証導入を妨げない設計とする

---

## 5. 依存・外部インターフェース

### 5.1 Kubernetes API
- BFF はクラスタ外から Kubernetes API にアクセスする
- 必要 RBAC は chart により作成される（pods/exec/log/services/endpoints 等）

### 5.2 Chain RPC / REST
- BFF は chain の RPC/REST にアクセスする
- endpoint 解決は env 固定または K8s discovery により行う
- 上流不達は 503、上流エラーは 502 で返す（識別）

---

## 6. 受け入れ基準（Acceptance Criteria）

### 6.1 第一層
- Helm install 済み環境で `/system/preflight` が overallOk=true を返す
- `/system/start` 実行でジョブが作成され、完了後に relayer が稼働し、チェーン間接続が成立する
- `/system/status` が Ready/NotReady を適切に要約し、relayer稼働有無が分かる

### 6.2 第二層
- `/chains` が Pod 起点で chainId 一覧を返す
- simulate/broadcast/tx/blocks/accounts/status が期待通り取得できる
- `blocktime` が固定定義で算出され、windowキャッシュが効く（同一latestHeightなら cached=true）

### 6.3 第三層
- tx confirmation（単発/バッチ）が timeout まで待機し、成功時に latencyMs を返す
- throughput が固定定義に従い、必要な根拠フィールドを返す
- broadcast-batch が maxConcurrency/maxBatchSize を守りつつ実行され、成功率・エラーが集計される
- resource-snapshot が system+chain の状態をまとめて返す

### 6.4 APIJOB
- System/Utils どちらでもジョブが作成・参照・ログ取得・キャンセルできる
- BFF再起動でジョブ一覧がクリアされる（仕様通り）

---

## 7. 将来拡張（v2以降の候補）
- Helm install/uninstall を Job 方式等で安全に取り込む
- WebSocket/イベント配信
- ジョブ永続化（DB/オブジェクトストレージ）
- 認証（token/role分離）
- 署名補助（signDoc素材生成など）

---

## 8. 変更履歴
- 1.0.0: v1 初版（3層＋ジョブ基盤、helm操作はスコープ外、TPS/throughput固定定義）
