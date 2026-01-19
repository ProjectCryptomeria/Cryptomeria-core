# 実験用APIサーバー要件（Cryptomeria BFF / TypeScript + Hono）

## 1. 背景・目的
卒業研究の実験（`docs/実験/卒業研究実験案.md` の A〜F）において、毎回 `kubectl exec`・`kubectl cp`・`port-forward`・bash を手動で叩く運用は、

- 操作コストが高い
- 手順ミス/環境差分が起きやすい
- 実験パラメータと観測結果（TxHash/height/タイムスタンプ/ブロック情報/負荷情報）が紐づかず再現性が下がる

という問題がある。

そこで本サーバーは **Cryptomeria-core（バックエンド）** と **簡易クライアント（フロント：wallet相当）** の間に挟まる **BFF（Backend for Frontend）** として、

- クライアントが **Txを作成・署名するための情報を提供**
- クライアントが作成した **署名済みTxをバックエンドへ中継（broadcast）**
- 併せて、実験の説明力を上げるための **観測系ユーティリティ（mempool/ブロック/負荷など）** を提供

する。

実装は **TypeScript + Hono** を前提とする。

---

## 2. 重要方針（設計の軸）
### 2.1 BFFは秘密鍵を持たない（署名しない）
- 署名は常に **クライアント（wallet相当）** が行う。
- BFFは **署名に必要な情報** と **署名済みTxの中継** を担う。

### 2.2 BFFはDBを持たない（永続化しない）
- BFFは **実験ログや結果を永続保存しない**。
- 実験ログ・観測結果・TxHash一覧などの保存は **クライアント側の都合で行う**（ファイル保存、スプレッドシート、任意DBなど）。
- BFFが返すのは「橋渡しのために必要な情報」と「観測データ（その場の取得結果）」のみ。

> 注：DBレスでも、実装上の一時メモリ（短命のキャッシュ/WS購読のセッション状態）は許容する  
> （例：`/ws` 接続ごとの購読状態、数秒〜数十秒の直近ブロックのメモリキャッシュ等）

### 2.3 Tx中身の解釈は最小限（“橋渡し”に徹する）
- broadcast APIは基本、署名済みTx（`txBytes`）を **ブラックボックスとして**扱い中継する。
- ただし観測系の利便性のために、`chainId`、`txhash`、`height` 等の最低限の紐づけは返す。

### 2.4 simulateは「単純一元化」を優先する
- `simulate` が巨大データで重くなる可能性は **今回は許容**する。
- 複雑な推定や段階的最適化よりも「同じ手順で必ず測れる」ことを優先する。

---

## 3. スコープ
### 3.1 対象
- Kubernetes上のCryptomeria-core（Helmデプロイ）
  - GWC（Gateway chain）
  - MDSC（Meta store chain）
  - FDSC（File data store chain、複数）
  - Relayer
- クライアント（wallet相当を含む簡易クライアント）
- BFFが提供する機能
  - Tx作成/署名に必要な情報提供
  - simulate（ガス見積り）
  - 署名済みTxのbroadcast中継
  - 観測ユーティリティ（mempool/ブロック/tx一覧/負荷）

### 3.2 非目標
- 実験手順を丸ごと自動実行する「実験実行API（run管理/結果DB保存）」の提供
- Cryptomeria-coreのオンチェーン仕様変更（計測モジュール追加等）
- 汎用K8s管理ツール化

---

## 4. 前提（Cryptomeria-core側）
- Namespace: `cryptomeria`（既定）
- Serviceは `type: NodePort` で外部公開されている（例：`cryptomeria-gwc`）
- 各チェーンは REST(1317) / RPC(26657) / gRPC(9090) を持ちうる
- **NodePortは values 等（例：gwcBase）に依存して変わりうる**ため、
  **BFFは固定値に依存せず、クラスタ起動後にServiceから動的に解決する必要がある**
- 観測のため **CometBFT/Tendermint RPC(26657) に到達可能**であること
- （任意）metrics-server が導入済みなら負荷観測を強化できる

---

## 5. 接続方式（Kubernetes / ネットワーク）
### 5.1 Kubernetes接続情報（方式B：クラスタ外実行を基本）
本BFFは **方式B（ローカル/別VMで実行）** をデフォルトとする（卒研のPDCA速度を優先）。

- 必要最小:
  - `KUBECONFIG`（context固定推奨）
  - Kubernetes API Server への到達性（VPN/FW含む）
  - Namespace（例：`cryptomeria`）

### 5.2 NodePort前提の Endpoint Discovery（必須）
BFFはクラスタ外からREST/RPC/WebSocketへアクセスするため、**ServiceのNodePortを動的に解決して base URL を組み立てる**。

#### 5.2.1 解決対象（最低限）
- `cryptomeria-gwc`（必須）
- `cryptomeria-mdsc`（任意：クライアント要件に応じて）
- `cryptomeria-fdsc-0`, `cryptomeria-fdsc-1`, ...（任意：観測や参照に応じて）

#### 5.2.2 解決方法（kubectl describe 相当）
- Kubernetes APIで Service を取得し、`spec.ports[]` を読む
- `ports[].name` で `api|rpc|grpc` を判別し、対応する `nodePort` を採用する
- 解決結果として、各チェーンの以下を生成する
  - `restBase = http://{nodeHost}:{apiNodePort}`
  - `rpcBase  = http://{nodeHost}:{rpcNodePort}`
  - `grpcAddr = {nodeHost}:{grpcNodePort}`（任意）
  - `wsRpcUrl = ws://{nodeHost}:{rpcNodePort}/websocket`（任意）

> 重要：NodePortは values（例：gwcBase）から計算され得るため、BFFは **valuesを読むのではなく、実態（Service）を信頼**する。

#### 5.2.3 nodeHostの決め方（必須＋推奨）
NodePortは自動解決できるが、`nodeHost`（どのホスト名/IPを叩くか）は環境依存になりやすい。  
そのためBFFは以下の優先順位で `nodeHost` を確定する。

1. **手動指定（最優先・最も確実）**
   - 例：`NODE_HOST=localhost`（port-forward利用時）
   - 例：`NODE_HOST=<到達可能なNode IP>`（NodePort直叩き時）
2. **自動推定（任意：できれば）**
   - K8sの Node 一覧から ExternalIP / InternalIP を候補として列挙
   - `http://{candidate}:{rpcNodePort}/status` 等で疎通チェックして採用
3. 推定できなければエラー（設定不足として扱う）

> 推奨：まずは (1) を採用し、「NodePortは自動」「hostは最小設定」で運用する。  
> 実験環境が安定してきたら (2) を追加する。

#### 5.2.4 解決結果の可視化（必須）
- BFFは「自分がどの endpoint を使うと判断したか」を確認できるようにする
- `GET /api/v1/chains` / `GET /api/v1/chains/{chainId}/info` で返す

---

## 6. BFFの基本機能（必須）
### 6.1 バック→フロント（Tx作成・署名に必要な情報を返す）
クライアントが「署名可能なTx」を作るために必要な情報を提供する。

- Chain情報
  - chain-id
  - REST/RPC エンドポイント（BFFが解決したbase）
  - （必要なら）bech32 prefix
- Account情報（署名に必須）
  - account_number
  - sequence
- Fee / Gas（署名・Tx作成に必要）
  - 推奨fee/gasの提示（固定値でもよい）
  - simulate結果による推奨値（後述）

### 6.2 フロント→バック（署名済みTxの中継を助ける）
クライアントが署名したTxを受け取り、バックエンドに投げる（broadcastする）。

- 入力: `txBytes`（base64など）
- 出力: `txhash`（およびブロードキャスト結果）
- 追加情報:
  - broadcast時刻（BFF側の観測時刻）
  - （可能なら）inclusion確認用の手掛かり（height等）

---

## 7. ガス代シミュレーション（必須）
### 7.1 目的
- クライアントが提示した **データサイズ（MsgUpload.data）** を含むTxについて、
  - `gasUsed / gasWanted`
  - 推奨fee（任意）
を得ることで、実験で「サイズとコストの関係」を観測できるようにする。

### 7.2 方針
- simulateが重い（巨大データ）の可能性は **許容**する。
- 処理は単純に統一し、毎回同じやり方で測れることを優先する。

---

## 8. 観測ユーティリティ（追加機能：推奨）
本BFFは「実験を直接走らせるAPI」ではなく、実験を補助する観測エンドポイントを提供する。

### 8.1 mempool / ブロック / tx観測（RPC）
- mempoolの未確定Tx数（num_unconfirmed_txs）
- 最新ブロック高と時刻（status / block）
- ブロック生成間隔（block time）の推移
- 指定ブロックに含まれる tx hash 一覧
- tx hash の確定状況（tx検索・高さ・コード）

### 8.2 ノード/Pod負荷（K8s）
- Pod CPU/Memory（可能なら）
- 再起動回数、OOM兆候
- PodがどのNodeにいるか（nodeName）

> DBレス方針のため、これら観測は「その場の取得結果」を返すのみ  
> 長期保存や集計はクライアント側が行う

---

## 9. API設計（Hono）
### 9.1 基本
- Base path: `/api/v1`
- 返却: JSON
- 認証（最低限）: `Authorization: Bearer <token>`
- DBレス: サーバーは永続保存しない

### 9.2 REST + WebSocket
- REST: 単発取得（account/sequence, simulate, broadcast, blocks）
- WebSocket: 継続監視（new block, mempool推移, tx確定イベント相当）

---

## 10. APIエンドポイント（必須＋推奨）
### 10.1 Discovery（必須）
- `GET /api/v1/chains`
  - BFFが認識しているチェーン一覧（`gwc`, `mdsc`, `fdsc-0`, ...）

- `GET /api/v1/chains/{chainId}/info`
  - 返却例: `{ chainId, serviceName, restBase, rpcBase, wsRpcUrl?, grpcAddr? }`

### 10.2 Chain / Account（署名材料）
- `GET /api/v1/chains/{chainId}/accounts/{address}`
  - `{ address, accountNumber, sequence }`

### 10.3 Simulate（必須）
- `POST /api/v1/chains/{chainId}/simulate`
  - 入力（例）:
    - `{ txBytesBase64 }`（署名前提で「同じ手順で測る」最短案）
  - 返却:
    - `{ gasUsed, gasWanted, recommendedFee?, raw }`

### 10.4 Broadcast（必須）
- `POST /api/v1/chains/{chainId}/broadcast`
  - 入力: `{ txBytesBase64, mode?: "sync"|"async"|"commit" }`
  - 返却: `{ txhash, broadcastResult, observedAt }`

### 10.5 Tx確認（推奨）
- `GET /api/v1/chains/{chainId}/tx/{txhash}`
  - `{ txhash, height, code, rawLog, timestamp? }`

### 10.6 観測ユーティリティ（推奨）
- `GET /api/v1/chains/{chainId}/mempool`
- `GET /api/v1/chains/{chainId}/status`
- `GET /api/v1/chains/{chainId}/blocks/latest`
- `GET /api/v1/chains/{chainId}/blocks/{height}`
  - `includeTxHashes=true|false`
- `GET /api/v1/chains/{chainId}/blocks/{height}/txs`
- `GET /api/v1/chains/{chainId}/blocktime`
  - `window=50` or `fromHeight/toHeight`

### 10.7 K8s負荷（任意）
- `GET /api/v1/k8s/pods`
  - `component=gwc|mdsc|fdsc|relayer`、`instance=fdsc-0`（任意）

---

## 11. 設定（最小化しつつ自動組み立て）
BFFは「固定の base URL」を環境変数で持たず、**Serviceから動的に組み立てる**。

- 必須（方式B）
  - `KUBECONFIG`（またはデフォルトパス）
  - `K8S_NAMESPACE=cryptomeria`
- 推奨（nodeHost確定用）
  - `NODE_HOST=localhost|<node-ip>|<host>`（これだけ手動でOKにするのが堅実）
- 任意（自動推定を有効化）
  - `AUTO_DETECT_NODE_HOST=true|false`

---

## 12. 非機能要件
### 12.1 セキュリティ
- APIは原則クローズド（学内ネット/VPN）
- Bearer token等で最低限の認証
- BFFは秘密鍵を保持しない（ログにも出さない）
- クライアントが送る `txBytes` をログにフルで出さない（サイズ/ハッシュのみ推奨）

### 12.2 信頼性
- REST/RPC呼び出しはtimeoutを持つ（例：10s）
- NodeHost自動推定は失敗し得るため、`NODE_HOST` 指定で必ず動くフォールバックを用意する
- DBレスのため、サーバー再起動で状態が消える前提

---

## 13. 実装メモ（TypeScript + Hono）
- Hono: ルーティング
- zod: 入力バリデーション
- undici: REST/RPC呼び出し
- `@kubernetes/client-node`: Service/Node取得、（任意）port-forward補助、pod負荷取得
- WebSocket: HonoのWSサポート or Node WS

---

## 将来対応（必要になったら）
- クライアントの利便性のために「Tx組み立て（Unsigned）支援」APIを追加
  - 例：`POST /api/v1/chains/{chainId}/build/upload` → `signDoc` を返す
- WebSocketでCometBFT購読（/websocket）を使った本格的push監視
- 方式A（クラスタ内デプロイ）への移行（RBAC最小権限、in-cluster config）
- メトリクス（Prometheus）提供（DBレス方針は維持可能）
