# Cryptomeria Secure Download (CSD) プロトコル定義書 v1.3

本書は、Cryptomeria における **安全かつ分散可能なダウンロード**を実現するための **CSD (Cryptomeria Secure Download) プロトコル**を定義する。  
CSD は「巨大データは HTTP で取得し、正しさは暗号学的検証によって担保する」ことを原則とし、ダウンロードのたびにブロックチェーン履歴が増える方式（巨大データのオンチェーン保存、またはダウンロードごとのオンチェーン書き込み）を禁止する。

v1.3 の前提は以下である。

- クライアントは ZIP をアップロードするが、システムは ZIP を保存しない。
- CSU の通り、アップロード時に ZIP を解凍し **Entry（ファイル）単位**に分解し、
  - `filepath` 昇順で取り扱い、
  - **ファイル本体（bytes）だけ**を保存する。
- よって、ダウンロード時に ZIP 圧縮・ZIP 復元は不要であり、`/render` は指定 `filepath` のファイル bytes を返す。

---

## 1. 用語と登場人物（主体 / 客体）

### 1.1 Actor（主体）

- **Client（クライアント）**
  - ブラウザまたは SDK。
  - 本プロトコルにおける **最終的な検証主体**（データ採用の最終判断者）。
  - GWC-GW / MDSC / FDSC のいずれも信用しない。

- **GWC HTTP Gateway（GWC-GW）**
  - HTTP エンドポイント `/render/...` を提供するゲートウェイ。
  - 内部で MDSC/FDSC からファイル断片を取得し、目的 `filepath` のファイル bytes を復元して応答する。
  - **悪意があり得る主体**として扱い、Client は応答を暗号学的に検証する。

- **MDSC Node（MDSC）**
  - メタデータ（manifest 等）を HTTP で提供するノード。
  - **悪意があり得る主体**。

- **FDSC Node（FDSC）**
  - 断片データ（fragment）を HTTP で提供するノード。
  - **悪意があり得る主体**。

- **GWC Chain（チェーン）**
  - 合意された状態（State）を持つ台帳。
  - CSD で扱うオンチェーン情報は **小さいデータ（コミットメント、証明、ノード情報等）に限定**する。

### 1.2 Object（客体）

- **File（ファイル）**
  - 保存単位。`(project, version, filepath)` により一意に識別される。
  - Client が `/render` で取得する対象。

- **Release Record（公開コミット）**
  - `project/version` に対する「正」を固定する検証アンカー（小データ、オンチェーン）。

- **File Commitment（ファイルコミットメント）**
  - 特定 `filepath` の内容（バイト列）を一意に確定するコミット（小データ）。
  - 例: `file_hash = H(file_bytes)`

- **File Inclusion Proof（包含証明）**
  - `filepath` の File Commitment が Release Record の `root_commitment` に含まれることを示す証明（小データ）。

- **Chain State Proof（チェーン状態証明）**
  - Release Record がチェーン状態に実在することを示す証明（小データ）。
  - Client が追加通信なしで検証できる形で `/render` 応答に同梱される。

- **Endpoint Registry（ノード到達情報レジストリ）**
  - MDSC/FDSC の到達先集合をオンチェーンで共有する（小データ）。

- **Rendered File Payload（レンダー結果）**
  - `/render/...` 応答ボディとして返る、要求対象ファイルのバイト列（巨大データになり得る）。

- **CSD Envelope（検証封筒）**
  - Rendered File Payload を検証するためのコミットメント・証明を束ねた構造体（小〜中）。
  - **同一 HTTP 応答**で Client に渡される（追加リクエスト不要）。

---

## 2. 優先度（設計原則）

### P0: 巨大データはオンチェーン禁止（HTTP/Query以外で運ばない）
- 禁止: fragment/ファイル本体、巨大メタデータのオンチェーン保存
- 許可: 参照（query）と HTTP による取得

### P1: クライアント操作は「単一の GET /render/...」のみ
- Client が行うネットワーク処理は必ず次の 1 回のみ:
  - `GET /render/<project_name>/<version>/<filepath>`
- Client にチェーンRPC、MDSC/FDSC直叩き、複数回 fetch を要求しない。

### P2: ゼロトラスト（Client は GWC-GW/MDSC/FDSC を一切信用しない）
- `/render` 応答は改ざんされ得る前提。
- Client は暗号学的検証により採否を決める。

### P3: 固定 IP / SPOF と裏技運用の禁止
- 特定ノード固定で集中する仕組みを禁止。
- 起動時スクリプト注入等で到達先を固定する方式を禁止。

### P4: ノード情報共有は（新規 P2P 基盤を作らず）チェーンを用いる
- 到達先共有は Endpoint Registry を正とし、TTL/heartbeat で吸収。

### P5: オンチェーン書き込みは「小さい Tx」のみ許可
- 許可: endpoint 更新、release 記録、証明/コミットメント
- 禁止: ダウンロード要求ごとのTx、巨大データ保存

---

## 3. セキュリティモデル（P1制約下での成立条件）

### 3.1 問題設定
P1 により Client は `/render` しか叩けない。  
よって、悪意ある GWC-GW が `filepath` に対して **改ざん済みファイル bytes**を返すリスクがある。

### 3.2 解決方針（v1.3）
- `/render` 応答は **Rendered File Payload**（ファイル実体）と **CSD Envelope**（検証情報）を同一応答で返す。
- Client は追加通信なしに以下を検証する:

**(A) ファイル整合性**  
- `H(Rendered File Payload) == file_hash`

**(B) リリース整合性（包含証明）**  
- `file_hash`（および file_size/file_path）が `project/version` の `root_commitment` に含まれること

**(C) チェーン整合性**  
- `root_commitment` を含む Release Record がチェーン状態に実在すること（Chain State Proof）

### 3.3 信頼アンカー
- Client はチェーン検証のためにアウトオブバンドな trust anchor を持つ必要がある。
- `/render` 応答に含まれる情報を trust anchor として採用してはならない。

---

## 4. オンチェーン状態（小 Tx）

### 4.1 Release Registry（Release Record）

#### 目的
- `project/version` に対して **ファイル集合（filepath昇順）**の正を固定する。

#### 概念スキーマ（抽象）
- `project: ProjectID`
- `version: VersionID`
- `root_commitment: Digest`
  - Release 内ファイル集合のコミットメント（5章参照）
- `commitment_scheme: SchemeID`
  - 例: `CSD-FILEHASH-MERKLE-v1`
- `status: active | revoked`
- `created_at: height/time`
- `owner: address`（任意）

#### 生成主体 / 客体
- 主体: GWC（アップロード finalize 時等）
- 客体: Release Record（小 Tx）

---

### 4.2 Endpoint Registry v2（Endpoint Record）
（v1.1 と同じ。Client の単一GET要件とは独立）

---

## 5. コミットメント・スキーム（CSD-FILEHASH-MERKLE-v1）

v1.3 は `/render` が単一ファイル bytes を返すため、**ファイルバイト列へのコミット**を必須とする。  
これにより、Client は「指定ファイルが正であること」を単一GETで検証できる。

### 5.1 FilePath 正規化（規範）
`filepath` はコミットと検証の双方で同一でなければならない。  
正規化規則は以下を満たすこと:

- 区切りは `/`（スラッシュ）に統一
- 先頭 `/` を禁止（常に相対パス）
- `..` セグメントを禁止
- 空セグメント（`//`）を禁止
- 文字列エンコーディングは UTF-8 とし、必要なら NFC 正規化（実装依存だが同一化されること）

### 5.2 File Commitment（必須）
- `file_bytes` は `/render` が返すのと同一のバイト列とする。
- `file_hash = H(file_bytes)`（例: SHA-256）
- `file_size = len(file_bytes)`

**File Leaf（抽象）**
- `file_leaf = H( "FILE" || filepath || file_size || file_hash )`

### 5.3 Release Root Commitment（必須）
- 全 `file_leaf` を `filepath` の所定順序（例: 辞書順）で並べて構成する Merkle Root を `root_commitment` とする。

### 5.4 File Inclusion Proof（必須）
- `file_leaf` が `root_commitment` に含まれることを示す証明。
- 証明サイズは `O(log N)` を目標とし、`/render` 応答に同梱可能であること。

---

## 6. /render インターフェース（唯一のクライアント操作）

### 6.1 リクエスト
- 主体: Client
- 客体: GWC-GW HTTP
- 操作: `GET /render/<project_name>/<version>/<filepath>`
- 意味: Release 内の `filepath` に対応するファイル bytes を返す。

### 6.2 レスポンス（規範）
レスポンスは同一 HTTP 応答で以下を提供しなければならない。

- **Rendered File Payload（必須）**
  - 応答ボディとして返るファイルのバイト列（`file_bytes`）

- **CSD Envelope（必須）**
  - 追加通信なしで検証できる情報を同梱

#### CSD Envelope 最小要素（抽象）
- `project, version, filepath`（正規化後）
- `file_hash, file_size`
- `file_inclusion_proof`（file_leaf → root_commitment）
- `root_commitment`
- `release_record_ref`（Release Record 識別子）
- `chain_state_proof`（Release Record がチェーン状態に実在する証明）

### 6.3 CSD Envelope の搬送方式（同一応答内）
以下のいずれか（または両方）を準拠とする。

- **方式A: HTTP Trailer 搬送（推奨）**
  - ボディは純粋なファイル bytes（ブラウザ互換性が高い）
  - Trailer に `CSD-Envelope: <encoded>` を格納

- **方式B: バンドル Content-Type 搬送**
  - `Content-Type: application/csd+bundle`
  - ボディが `{ file_bytes, csd_envelope }` を含む単一構造

---

## 7. クライアント検証フロー（単一GET・ゼロトラストの両立）

### 7.1 検証手順（規範）
Client は `/render` 応答を受け取ったら、追加通信なしに次を実施する。

1. **File Hash 検証**
   - 入力: Rendered File Payload（ボディ）, `file_hash`（Envelope）
   - 検証: `H(body) == file_hash`
   - 不一致なら **即拒否**

2. **File Inclusion 検証**
   - 入力: `filepath, file_size, file_hash, file_inclusion_proof, root_commitment`
   - 手順:
     - `file_leaf = H("FILE" || filepath || file_size || file_hash)`
     - `VerifyInclusion(file_leaf, file_inclusion_proof, root_commitment) == true`
   - 不一致なら **拒否**

3. **Chain State 検証**
   - 入力: `chain_state_proof`（Envelope）, trust anchor（アウトオブバンド）
   - 検証: Release Record の `root_commitment` が合意されたチェーン状態に含まれること
   - 不一致なら **拒否**

4. **採用**
   - 1〜3 がすべて真なら、Client はボディを正として採用する。

### 7.2 セキュリティ結論（規範）
- GWC-GW が悪意でも、Client が 7.1 を実施する限り改ざんファイルは採用されない。
- Client は `/render` の単一 GET のみで検証を完結できる。

---

## 8. ノード間要件（SPOF回避・裏技排除）

- GWC-GW は MDSC/FDSC 到達先を固定せず、Endpoint Registry の有効集合から選ぶこと。
- endpoint 更新は TTL/heartbeat による正規手段とし、外部スクリプト注入を禁止する。
- 分散選択戦略（Rendezvous Hash 等）は実装依存だが、固定集中を生まないこと。

---

## 9. 禁止事項（Prohibitions）

- Client に `/render` 以外のネットワーク処理を要求すること
- ダウンロードの都度オンチェーンに書き込むこと（Tx）
- fragment/ファイル本体をオンチェーンへ保存すること
- 固定 endpoint（node-0 等）に依存すること
- 外部スクリプト注入により endpoint を固定すること
- CSD Envelope なしに `/render` 応答を正として扱うこと

---

## 10. 達成基準（Definition of Done）

1. Client は **単一の `GET /render/...`** のみでファイルを取得できる
2. `/render` 応答に **File Payload + CSD Envelope** が同梱される
3. Client が 7章の検証で、悪意ある GWC-GW の改ざんを必ず拒否できる
4. endpoint 固定がなく、TTL/heartbeat による複数到達先運用が可能
5. ダウンロード処理がオンチェーン履歴を増やさない（参照のみ）

---
