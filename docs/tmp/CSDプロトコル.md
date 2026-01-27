# Cryptomeria Secure Download (CSD) プロトコル定義書 v1.0

本書は、Cryptomeria における **安全かつ分散可能なダウンロード**を実現するための **CSD (Cryptomeria Secure Download) プロトコル**を定義する。  
CSD は「巨大データは HTTP で取得し、正しさは暗号学的検証によって担保する」ことを原則とし、ダウンロードのたびにブロックチェーン履歴が増える方式（巨大データのオンチェーン保存、またはダウンロードごとのオンチェーン書き込み）を禁止する。

---

## 1. 用語と登場人物（主体 / 客体）

本プロトコルは、複数の主体（Actor）が相互に通信し、ある主体が提供するデータ（客体 / Object）を別主体が取得・検証することによって成立する。

### 1.1 Actor（主体）

- **Client（クライアント）**
  - ユーザーの端末またはライブラリ。
  - 本プロトコルにおける **最終的な検証主体**（trust anchor を参照し検証を行う）。
  - GWC / MDSC / FDSC のいずれも信用しない。

- **GWC Node（GWC）**
  - Cryptomeria の中核チェーン（以下 GWC Chain）に接続するノード。
  - オンチェーンの参照（query）を提供する。
  - 追加で HTTP プロキシ（任意機能）を提供しうるが、**Client は GWC HTTP 応答を信用しない**。

- **MDSC Node（MDSC）**
  - Manifest を HTTP で提供するストレージ系ノード。

- **FDSC Node（FDSC）**
  - Fragment（巨大データの断片）を HTTP で提供するストレージ系ノード。

- **GWC Chain（チェーン）**
  - 合意された状態（State）を持つ台帳。
  - CSD で扱うオンチェーン情報は **小さいデータ（セッション/コミットメント/ノード情報等）に限定**する。

### 1.2 Object（客体）

- **Release Record（公開コミット）**
  - 「この project/version の正はこれである」という **検証アンカー**。
  - オンチェーンに保存される（小データ）。
- **Endpoint Registry（ノード到達情報レジストリ）**
  - MDSC/FDSC の到達先（API endpoint 等）集合をオンチェーンで共有する（小データ）。
- **Manifest（メタデータ）**
  - ファイル/ページを構成する断片情報（fragment_id 等）と検証情報（chunk_hash 等）を含む。
  - HTTP で取得する（中サイズ）。
- **Fragment（断片データ）**
  - ページ/ファイルの実体データ断片。巨大データ。
  - HTTP で取得する（巨大データ）。
- **Rendered File / Page（復元結果）**
  - Fragment を結合して得られる最終バイト列（巨大データ）。

---

## 2. 優先度（設計原則）

CSD は、設計上の衝突が起きた場合、以下の優先度で採否を決める。

### P0: ダウンロードは IBC を使用しない（HTTP で取得する）
- ダウンロードデータ取得は HTTP のみとする。
- ダウンロードのたびにオンチェーン履歴を増やす方式は不採用。
- オンチェーンは **参照（query）** のみ使用し、ダウンロード要求に伴う Tx は行わない。

### P1: ゼロトラスト（Client が GWC/MDSC/FDSC を一切信用しない）
- Client は、GWC/MDSC/FDSC の応答が悪意により改ざんされ得る前提で動作する。
- Client は暗号学的検証により、取得データの採否を決める。

### P2: 固定 IP / SPOF と裏技運用の禁止
- 特定ノード固定でリクエストが集中する仕組みを禁止する。
- リレイヤーや起動スクリプト等による「外部注入」で到達先を固定する方式を禁止する。

### P3: ノード情報共有は（新規 P2P 基盤を作らず）チェーンを用いる
- ノード到達情報の共有はオンチェーンの Endpoint Registry を正とする。
- 頻繁な変更は TTL/heartbeat で吸収する。

### P4: オンチェーン書き込みは「小さい Tx」のみ許可
- 許可: endpoint 登録/更新、release 記録、セッション/証明等の小データ
- 禁止: fragment 本体、ファイル本体、巨大メタデータのオンチェーン保存

---

## 3. セキュリティモデル

### 3.1 信頼しないもの
Client は以下を信頼しない。
- GWC/MDSC/FDSC の HTTP 応答内容
- 単一ノードの提供する endpoint 情報
- ネットワーク上の中間者

### 3.2 信頼アンカー
- Client は **GWC Chain の合意状態**を信頼アンカーとする。
  - 実装形態（light client / state proof / 信頼されたRPC等）は実装依存。
  - 本プロトコルは「チェーン状態に固定されたコミットメント」を検証基準として要求する。

### 3.3 攻撃に対する要件
- 悪意ある MDSC が偽 manifest を返しても Client が採用しないこと。
- 悪意ある FDSC が偽 fragment を返しても Client が採用しないこと。
- いずれかのノードが停止/劣化しても、Client が別ノードへフォールバックできること。

---

## 4. オンチェーン状態（小 Tx のみ）

本節の状態は GWC Chain に存在し、Client は query で参照する。  
ダウンロード要求に伴う Tx は行わない。

### 4.1 Release Registry（ReleaseRecord）

#### 目的
- `(project, version)` に対して **正しい公開物のコミットメント**を固定し、Client が検証基準として参照できるようにする。

#### 概念スキーマ（抽象）
- `project: ProjectID`
- `version: VersionID`
- `session_id: SessionID`
- `root_proof: RootProof`  
  - CSU RootProof v1（または互換版）に準拠する
- `manifest_digest: Digest`  
  - manifest の正規化表現に対するハッシュ
- `fragment_size: uint`  
- `status: active | revoked`
- `created_at: height/time`
- `owner: address`（任意）

#### 生成主体 / 客体
- 主体: GWC（アップロード finalize 時）
- 客体: ReleaseRecord（小 Tx）

#### 制約
- 1つの `(project, version)` に対し、有効な ReleaseRecord は高々1つ（active）。
- revoked はクライアントが拒否する。

---

### 4.2 Endpoint Registry v2（EndpointRecord）

#### 目的
- 固定IPを排し、MDSC/FDSC の複数 endpoint をチェーン上で共有する。

#### 概念スキーマ（抽象）
- `role: "mdsc" | "fdsc"`
- `storage_id: StorageID`  
  - 例: fdsc_id / mdsc_id など（システムで一意）
- `node_id: NodeID`
- `api_endpoint: URL`
- `weight: uint`（任意）
- `expires_at: height/time`（TTL）
- `last_seen: height/time`（任意）

#### 登録主体 / 客体
- 主体: MDSC/FDSC（自己 heartbeat により更新）  
  - （拡張）GWC が観測した endpoint を「証明付きで」登録する方式も許容
- 客体: EndpointRecord（小 Tx）

#### 制約
- TTL を持ち、期限切れ endpoint は無効扱い。
- 役割ごとに許可された node_id / owner により更新権限を制御できる（実装依存）。

---

## 5. オフチェーン取得（HTTP）と検証オブジェクト

### 5.1 CSD Manifest v1

#### 目的
- file/page を復元するための断片情報を提供し、Client が改ざん検知できるようにする。

#### 必須要件
manifest は少なくとも以下を含む（抽象）。
- `project, version, session_id, fragment_size`
- `root_proof`（ReleaseRecord と一致すること）
- `files[path]`:
  - `size`
  - `mime_type`（任意）
  - `file_root`（Merkle root 等）
  - `fragments[]`:
    - `fdsc_id: StorageID`
    - `fragment_id: FragmentID`
    - `chunk_hash: Digest`  
      - fragment バイト列のハッシュ（改ざん検出のため必須）

#### 生成主体 / 客体
- 主体: MDSC（HTTPで提供）
- 客体: Manifest

---

### 5.2 Fragment

#### 目的
- file/page の実体断片を提供する。

#### 形式
- `fragment_bytes`（巨大データ）
- 付随情報（任意）: session_id/path/index 等

#### 生成主体 / 客体
- 主体: FDSC（HTTPで提供）
- 客体: Fragment

---

## 6. プロトコル・フロー（抽象）

本節では「主体が誰で、誰に対して、何を要求し、何を検証し、採用するか」を定義する。  
具体APIパス、protoフィールド、エラーコード等は実装依存とする。

---

### 6.1 Node Discovery（到達先の発見）

#### 目的
- Client が固定IPに依存せず、複数の MDSC/FDSC endpoint を得る。

#### フロー
1. **Client（主体）→ GWC Chain（客体）**: Endpoint Registry を query
2. Client は `role=mdsc` および `role=fdsc` の有効 endpoint（TTL内）集合を得る
3. Client は endpoint 集合から取得先を選択する（選択戦略は 7章）

#### 成功条件
- 単一 endpoint 固定に依存せず、複数候補が得られること

---

### 6.2 Release Anchor Fetch（検証アンカーの取得）

#### 目的
- Client が `project/version` の正を確定し、以後の HTTP 応答を検証できるようにする。

#### フロー
1. **Client（主体）→ GWC Chain（客体）**: ReleaseRecord(project, version) を query
2. Client は `root_proof, manifest_digest, session_id, fragment_size, status` を得る
3. `status != active` の場合、Client はダウンロードを拒否する

#### 成功条件
- Client が検証に必要なアンカーを確定できること

---

### 6.3 Manifest Fetch & Verify（manifest の取得と検証）

#### 目的
- MDSC が悪意でも偽 manifest を採用しない。

#### フロー
1. **Client（主体）→ MDSC endpoint（客体）**: manifest を HTTP 取得
2. Client は manifest を正規化表現（canonical）に変換し `digest = H(canonical_manifest)` を計算
3. Client は `digest == ReleaseRecord.manifest_digest` を検証する
4. 不一致なら、その MDSC 応答を破棄し、別 MDSC にフォールバックする
5. 一致なら、manifest を採用し次へ進む

#### 成功条件
- 単一 MDSC の応答で改ざんが通らないこと（必ず digest 不一致で検知される）

---

### 6.4 Fragment Fetch & Verify（fragment の取得と検証）

#### 目的
- FDSC が悪意でも偽 fragment を採用しない。

#### フロー（各 fragment について）
1. **Client（主体）→ FDSC endpoint（客体）**: fragment_id を指定して HTTP 取得
2. Client は `calc = H(fragment_bytes)` を計算
3. Client は `calc == manifest.fragments[i].chunk_hash` を検証する
4. 不一致なら、その FDSC 応答を破棄し、別 FDSC endpoint にフォールバックする
5. 一致なら、その fragment を採用し、復元バッファに格納する

#### 成功条件
- 単一 FDSC の応答で改ざんが通らないこと（chunk_hash 不一致で検知される）

---

### 6.5 Reconstruct & End-to-End Verify（復元とE2E検証）

#### 目的
- 断片が揃っても「復元結果が正」であることを最終的に保証する。

#### フロー（path について）
1. Client は fragments を順に結合して `file_bytes` を復元する
2. Client は manifest 内の `file_root` を再計算し一致を検証する  
   - `file_root == manifest.files[path].file_root`
3. Client は `root_proof`（CSU RootProof v1 等）を再計算し一致を検証する  
   - `computed_root_proof == ReleaseRecord.root_proof`
4. いずれか不一致なら復元結果を破棄し、必要に応じて別ノードで再取得する
5. 一致なら Client は `file_bytes` を最終結果として採用する

#### 成功条件
- どのノードが悪意でも、E2E検証が通らない限り Client が誤ったバイト列を採用しないこと

---

## 7. Endpoint 選択戦略（分散とSPOF回避）

### 7.1 要件
- 全 Client / 全 GWC が同一 endpoint を叩く固定集中を避ける。
- 取得失敗時のフェイルオーバーが可能であること。

### 7.2 推奨戦略（例）
- **Rendezvous Hash（推奨）**
  - `target = argmax_endpoint H(key, endpoint_id)`  
  - `key` は `manifest_digest` や `fragment_id` 等を利用
  - 特徴: 分散が自然で、候補集合が変わっても影響が局所的
- ランダム（seed = session_id 等）
- 重み付き選択（weight がある場合）

### 7.3 フェイルオーバー
- 選択した endpoint が失敗/不一致を返した場合、次順位の endpoint に切り替える。
- “不一致”は改ざん/故障両方を含み、同様に扱ってよい。

---

## 8. ハッシュ／検証関数（抽象）

### 8.1 Digest 関数
- `H(x)` は暗号学的ハッシュ関数（例: SHA-256）を表す。
- `Digest` は固定長バイト列（表示は hex 等）とする。

### 8.2 Canonical Manifest
- manifest_digest は「manifest の正規化表現」に対するハッシュである。
- 正規化方法（proto deterministic marshal 等）は実装により定めるが、  
  **全 Client が同一入力から同一 digest を得る**ことを必須とする。

### 8.3 RootProof / Merkle
- `root_proof` は CSU RootProof v1（または互換）の計算規則に従う。
- CSD は `root_proof` の値そのものを検証アンカーとして利用し、  
  実装において同一規則で再計算できることを要求する。

---

## 9. 禁止事項（Non-Goals / Prohibitions）

- ダウンロードの都度、オンチェーンにデータを書き込む（Tx）こと
- fragment 本体や file 本体をオンチェーンに保存すること
- MDSC/FDSC の単一固定 endpoint に依存すること
- 外部スクリプト注入により endpoint を固定すること
- HTTP 応答を検証なしで採用すること（manifest / fragment / 復元結果のいずれも）

---

## 10. 相互運用性・拡張（非規範）

- Client がチェーン状態の正当性をより強く担保するために、state proof / light client を導入してよい。
- Endpoint 登録を「第三者観測で共有」したい場合、署名付きアテステーション方式を追加してよい。
- GWC が HTTP プロキシ（/render 等）を提供する場合でも、Client 側の検証フローは省略してはならない。

---

## 11. 達成基準（Definition of Done）

CSD の実装が成功したとみなす最低条件は以下である。

1. Client は ReleaseRecord を参照し、manifest_digest / root_proof によって改ざんを検出できる
2. Client は chunk_hash によって fragment 改ざんを検出できる
3. endpoint が複数存在し、固定集中せずフェイルオーバー可能である
4. ダウンロード処理がオンチェーン履歴を増やさない（参照のみ）
5. 外部スクリプト注入を不要とし、ノード自身の正規手段で endpoint が更新される（TTL/heartbeat）

---
