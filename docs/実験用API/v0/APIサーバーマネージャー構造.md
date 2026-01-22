# BFFサーバーのマネージャー分割による構造化（K8s / Cryptomeria / Client API）

本BFFは機能が増えやすく（discovery・tx支援・観測・WS等）、単一ファイル/単一層の実装にすると保守が難しくなる。
そこで **責務ごとに「マネージャー（Manager）」を分離**し、コード構造を明確化する。

---

## 1. 目的
- 「どこで何をしているか」を追いやすくする（卒研の実験装置として重要）
- NodePort解決、REST/RPC呼び出し、WS監視、クライアント向けのI/F整形を分離する
- 将来（方式A移行、監視拡張、fdsc台数増、WS購読強化）に耐える

---

## 2. 全体構造（3つのマネージャー）
BFFは以下の3つのマネージャーを中心に構成する。

1) **K8sManager（Kubernetesマネージャー）**  
   - K8s APIを叩く層（Service/Node/Pod等）
   - NodePortの動的解決（Endpoint Discovery）を提供

2) **CryptomeriaManager（Cryptomeriaマネージャー）**  
   - Cryptomeria（Cosmos/CometBFT）のREST/RPC/WSを叩く層
   - simulate / broadcast / tx確認 / block観測 / mempool観測 等のドメイン機能を提供
   - 依存：解決済み endpoint（restBase/rpcBase/wsRpcUrl 等）

3) **ClientApiManager（クライアントAPIマネージャー）**  
   - Honoのルーティング（HTTP/WS）に近い層
   - 入力バリデーション、レスポンス整形、エラーマッピング
   - 依存：CryptomeriaManager と K8sManager（必要なものだけ）

> ルータは「薄く」、実処理はマネージャーに寄せる（コントローラ肥大を防ぐ）

---

## 3. 依存関係とデータフロー
### 3.1 依存関係（推奨）
- ClientApiManager
  - 依存：CryptomeriaManager（必須）
  - 依存：K8sManager（discovery/負荷観測を提供するルートでのみ）
- CryptomeriaManager
  - 依存：EndpointResolver（K8sManagerが提供する解決結果 or それをラップしたもの）
- K8sManager
  - 依存：`@kubernetes/client-node`

### 3.2 データフロー例
- `/api/v1/chains`
  - ClientApiManager → K8sManager（ServiceからnodePort解決）→ 返却整形

- `/api/v1/chains/gwc/accounts/{address}`
  - ClientApiManager → CryptomeriaManager（RESTへ）→ 返却整形

- `/api/v1/chains/gwc/broadcast`
  - ClientApiManager → CryptomeriaManager（REST/RPCでbroadcast）→ 返却

- `/api/v1/ws/chains/gwc`
  - ClientApiManager → CryptomeriaManager（RPC WS subscribe）→ クライアントへ中継

---

## 4. K8sManager 要件
### 4.1 責務
- K8s APIから以下を取得/解決する
  - Service一覧 / Service詳細
  - Node一覧（必要なら）
  - Pod一覧（負荷・再起動など、任意）
- NodePort前提の Endpoint Discovery を実装し、BFF内の他コンポーネントへ提供する

### 4.2 提供インタフェース（例）
- `listChainServices(namespace): Service[]`
- `resolveChainEndpoints(namespace, chainId | serviceName): ChainEndpoints`
  - `ChainEndpoints`:
    - `chainId`
    - `serviceName`
    - `apiNodePort?` / `rpcNodePort?` / `grpcNodePort?`
    - `restBase` / `rpcBase` / `wsRpcUrl?` / `grpcAddr?`
    - `resolvedAt`
- `resolveAllEndpoints(namespace): Record<chainId, ChainEndpoints>`
- `detectNodeHost(options): string`（任意）
  - 優先：`NODE_HOST` → 自動推定（疎通チェック）→ error
- （任意）`listPods(filter): PodInfo[]`
- （任意）`getPodMetrics(filter): PodMetrics[]`（metrics-server がある場合）

### 4.3 実装上の要件
- `ports[].name` で `api|rpc|grpc` を判定して `nodePort` を採用する
- `values.yaml` を読んで計算はしない（**実態のServiceを信頼**）
- 失敗した場合のエラーを「設定不足」と「K8s取得失敗」に分ける

---

## 5. CryptomeriaManager 要件
### 5.1 責務
- 解決済み endpoint を用いて、Cryptomeria（Cosmos/CometBFT）の機能を提供する
- 署名はクライアントが行う前提のため、以下を中心に実装する
  - 署名材料の取得（account_number / sequence / chain info）
  - simulate（ガス見積り）
  - broadcast（署名済みTx中継）
  - tx確認
  - mempool/ブロック観測（REST/RPC）
  - WS購読（任意）

### 5.2 提供インタフェース（例）
- `getChainInfo(chainId): ChainInfo`
- `getAccount(chainId, address): AccountInfo`
  - `{ accountNumber, sequence }`
- `simulateTx(chainId, txBytesBase64 | payload): SimulateResult`
- `broadcastTx(chainId, txBytesBase64, mode): BroadcastResult`
- `getTx(chainId, txhash): TxResult`
- `getMempool(chainId): MempoolInfo`
- `getStatus(chainId): StatusInfo`
- `getBlock(chainId, height | latest): BlockInfo`
- `getBlockTxHashes(chainId, height): string[]`
- `getBlockTimeSeries(chainId, window | range): BlockTimeSeries`
- `wsSubscribe(chainId, topics, onEvent): UnsubscribeFn`（任意）

### 5.3 実装上の要件
- REST/RPC呼び出しは timeout を統一（例：10s）
- 大きい入力（simulate/broadcast）はサイズ上限を設ける（値は実験条件で決める）
- WSは切断・再接続を考慮（最低限：再接続ループ、購読復元）

---

## 6. ClientApiManager 要件（Hono ルート管理）
### 6.1 責務
- Honoのルーティングを提供し、各マネージャーを呼び出す
- 入力バリデーション（zod等）
- 結果の整形とエラーレスポンス統一
- 認証（Bearer token）
- DBレス方針：永続保存しない（ログは標準出力、必要ならアクセスログ）

### 6.2 ルーティング実装方針
- ルートは「薄く」保つ（処理はManagerへ委譲）
- 例外はすべて `ApiError` に統一して返す
  - `400` 入力不正
  - `401/403` 認証
  - `404` チェーン/エンドポイント未解決
  - `502/504` バックエンド呼び出し失敗/timeout
  - `500` 想定外

### 6.3 提供するAPI（要件本文のエンドポイントをそのまま実装）
- discovery: `/api/v1/chains`, `/api/v1/chains/{chainId}/info`
- tx支援: `/accounts`, `/simulate`, `/broadcast`, `/tx/{txhash}`
- 観測: `/mempool`, `/status`, `/blocks/...`, `/blocktime`
- k8s負荷（任意）: `/api/v1/k8s/pods`
- WS（任意）: `/api/v1/ws/chains/{chainId}`

---

## 7. コード構成（推奨ディレクトリ）
例（最小）：

- `src/`
  - `app.ts`（Hono app組み立て）
  - `config/`
    - `env.ts`（環境変数の読み取り・型付け）
  - `managers/`
    - `k8s-manager.ts`
    - `cryptomeria-manager.ts`
    - `client-api-manager.ts`
  - `types/`
    - `chains.ts`（ChainId/Endpoints/DTO）
    - `errors.ts`（ApiError）
  - `routes/`（必要なら：ClientApiManagerが巨大化したら分割）
    - `chains.ts`
    - `tx.ts`
    - `observe.ts`
    - `k8s.ts`
    - `ws.ts`

---

## 8. テスト方針（推奨・DBレス向き）
- Unit: Manager単体（HTTP呼び出しはモック）
- Integration: 実クラスタに対して `resolve endpoints → status → broadcast` まで通す（手元でOK）
- Contract: `/api/v1/chains` の返却形式を固定し、クライアントと齟齬を防ぐ

---

## 9. 追加の非機能（構造化に伴う）
- **観測/中継で同じ endpoint 解決を何度もしない**
  - K8sManagerは短時間キャッシュ（例：5〜30秒）を許容
  - DBレスでもメモリキャッシュはOK
- **ログは責務ごとに出す**
  - K8sManager: discovery失敗理由（service見つからない/port名がない等）
  - CryptomeriaManager: downstream timeout / rpcエラー / ws切断
  - ClientApiManager: リクエストID・処理時間・ステータス
