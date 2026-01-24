# 🛡️ CSUプロトコル 仕様書（改訂版：Session Close + Authz寿命同期）
> Cryptomeria Secure Upload Protocol (CSU)  
> **Authz（session_id固定） + Feegrant（Alice負担） + TUS（チャンク/再開） + RootProof（解凍後内容コミット）**  
> さらに本改訂では、**アップロード完了後/失敗時に「Txの一環としてセッションを閉じる」**こと、および **Authzの寿命をセッション寿命と完全に同期**することを仕様として追加する。

---

## 1. 概要

CSU は、クライアント（Alice）が ZIP コンテンツを分散ストレージ（FDSC-*）に安全に保存し、目録（Manifest）を MDSC に記録するためのプロトコルである。

本仕様は次を満たす：

- RootProof（旧 SiteRoot）を **解凍後ZIP内容（正規化ファイル集合）**から算出し、オンチェーンにコミット
- HTTPアップロードに **TUS** を採用（ZIPをチャンクでアップロード）
- 断片配布は **local-admin（GWC genesis account）** が **Authz** により代理実行
- 断片配布Tx等のガス代は **Feegrant により Alice が負担**
- **Authz は session_id で固定化**
- **アップロード完了後/失敗時に、GWCがTx処理の一環としてセッションを閉じる**
- **Authz の寿命（有効性）をセッション寿命と同一にする（closeで無効化/撤去）**

---

## 2. 用語

| 用語 | 説明 |
|---|---|
| RootProof | プロジェクト全体の決定論コミットメント（Merkle Root）。解凍後ZIP内容から計算 |
| Session | アップロード単位。`session_id` で識別 |
| Owner | Session 所有者（Alice） |
| Executor | 代理実行者。固定で `local-admin` |
| TUS | レジューム可能HTTPアップロード。ZIPをチャンクで送る |
| Fragment | 解凍後のファイルを `fragment_size` で分割した断片 |
| MerkleProof | FragmentがRootProofに含まれることを示す証明 |
| Session Close | Sessionを閉じる（後続操作を不可にし、Authz/Feegrantも無効化する） |

---

## 3. 参加者と前提

### 3.1 参加者
- Alice（Owner）
- local-admin（Executor / GWC genesis account）
- GWC chain
- FDSC-* chains
- MDSC chain
- Executor Node g（local-admin 鍵でTxを投げ、HTTPアップロード資材を扱うノード）

### 3.2 前提（固定要件）
1. Executor は `local-admin` 固定
2. Alice は事前に `local-admin` から Faucet を受ける
3. Fee は Alice が肩代わり（Feegrant）
4. Authz を採用し、固定化単位は `session_id`
5. ZIPのHTTPアップロードは TUS（チャンク/再開）

---

## 4. 脅威モデル（要約）

- GWC実行ノードが悪意：ZIP/断片改ざん、勝手な配布
- FDSCが悪意：断片汚染/欠落
- MDSCが悪意：manifest改ざん
- HTTPなりすまし/DoS
- Authz/Feegrant 濫用

**防御原理**：
- RootProof を先にオンチェーン固定し、配布前にオンチェーンで `verify_fragment` を強制
- session_id 固定のAuthzにより、local-admin が許可された session のみ処理可能
- Session Close により、完了/失敗で権限寿命も終了（これ以降の送信は拒否）

---

## 5. RootProof 仕様

### 5.1 RootProof 計算対象（重要）
- **ZIPを解凍した後のファイル集合**が対象
- ZIPバイト列の差（圧縮方式/メタデータ）は RootProof に影響しない
- 同一の展開内容なら RootProof は同一

### 5.2 ZIP展開の安全要件（Alice側・Executor側共通）
- `\` → `/` 正規化
- `path.Clean` 相当の正規化
- 絶対パス禁止
- `../` を含むパス禁止（Zip Slip対策）
- 先頭 `/` と `./` 除去
- 展開総量上限（例：100MB）を設定

### 5.3 RootProof v1（Merkle）
- ハッシュ：SHA-256
- Merkle：binary merkle、奇数は末尾複製
- 決定論順序：ファイルは `path` 昇順、断片は `index` 昇順

**Fragment leaf**
- `leaf_frag = SHA256("FRAG:{path}:{index}:{hex(SHA256(fragment_bytes))}")`

**File root**
- `file_root = MerkleRoot(leaf_frag_hex[])`

**File leaf**
- `leaf_file = SHA256("FILE:{path}:{file_size}:{file_root}")`

**RootProof**
- `root_proof = MerkleRoot(leaf_file_hex[])`

**MerkleRoot**
- 入力が奇数なら末尾複製
- 親：`hex(SHA256(left_hex + right_hex))`（hex文字列連結をsha）

---

## 6. Proof 仕様（verify_fragment）

### 6.1 二段証明（推奨）
RootProof v1 は `FRAG → FILE → ROOT` の階層であるため、証明も二段が自然。

- FragmentProof：`leaf_frag` が `file_root` に含まれる証明
- FileProof：`leaf_file` が `root_proof` に含まれる証明

### 6.2 verify_fragment（Normative）
入力：
- `root_proof`（session が保持する hex）
- `path, index, fragment_bytes`
- `fragment_proof`（siblings/positions）
- `file_size, file_proof`（siblings/positions）

処理：
1. `leaf_frag = H("FRAG:{path}:{index}:{hex(H(fragment_bytes))}")`
2. `file_root = MerkleVerifyRoot(leaf_frag, fragment_proof)`
3. `leaf_file = H("FILE:{path}:{file_size}:{file_root}")`
4. `computed_root = MerkleVerifyRoot(leaf_file, file_proof)`
5. `computed_root == root_proof` を要求（不一致なら失敗）

---

## 7. 権限設計（Authz + Feegrant）— session寿命同期

### 7.1 目標
- local-admin が **当該 session に限って**配布/確定/中止を実行できる
- session が閉じられたら **Authz も同時に終了**する（寿命一致）

### 7.2 Authz（session_id固定）
Alice は local-admin に対して、少なくとも以下の操作を `session_id` 固定で許可する：

- `MsgDistributeBatch(session_id=...)`
- `MsgFinalizeAndCloseSession(session_id=...)`
- `MsgAbortAndCloseSession(session_id=...)`

> 注：標準のGenericAuthorizationではsession_id固定が弱い。  
> 本仕様は以下のいずれかを必須とする（推奨A）。

- **A) SessionBoundAuthorization（推奨）**  
  Authorization が `session_id` を内包し、`msg.session_id == authorization.session_id` を強制する。
- **B) Msg側で session 固定を強制（最低条件）**  
  各Msgハンドラで `session.owner` / `session.executor` / `authz grant存在` を検証し、session逸脱を不可能にする。

### 7.3 Authz寿命＝session寿命（必須）
CSUでは **Authzの寿命を session の生存期間と一致**させる。  
以下の二層で保証する（両方推奨）：

1) **論理的無効化（必須）**  
   - session が `CLOSED`（後述）になったら、モジュールは以後の `MsgDistributeBatch/Finalize/Abort` を **必ず拒否**する  
   - これにより、Authz grant がチェーン上に残っていても **実効的に無効**になる（寿命一致）

2) **物理的撤去（推奨）**  
   - `FinalizeAndClose` / `AbortAndClose` のTx処理内で、GWCモジュールが authz keeper を呼び出し、該当 grant を **revoke** する  
   - 可能なら feegrant allowance も同時に revoke（後述）

> 「Txの一環としてセッションを閉じる」の要求を満たすため、Close系Msgのハンドラ内で **(1) state更新 + (2) revoke** を同一Tx処理で行う。

### 7.4 Feegrant（Alice肩代わり）
- Alice は local-admin に feegrant allowance を付与
- local-admin が投げる配布/確定/中止Txの fee は Alice の残高から支払われる

**Feegrant寿命も session に同期（推奨）**
- `FinalizeAndClose` / `AbortAndClose` のTx処理内で allowance を revoke する（推奨）
- もしくは allowance を session の deadline と同一の expiration にする（最低限）

---

## 8. TUS による ZIP アップロード

### 8.1 認可（必須）
TUSアップロードには `session_upload_token`（capability）を必須にする。
- `InitSession` の応答で発行される（または同等の手段）

### 8.2 典型フロー
- `POST /files`（作成）
- `PATCH /files/<id>`（Upload-Offsetを進めてチャンク送信）
- `HEAD /files/<id>`（進捗確認）
- 完了条件：`Upload-Offset == Upload-Length`

### 8.3 アップロード失敗の定義（例）
- 期限（session.deadline）までに完了しない
- TUSストレージが破損/消失
- Owner が Abort を希望
- サーバが整合しないメタデータを検出

> 失敗時の session close は **Tx（AbortAndClose）を通じて行う**（本改訂要件）。

---

## 9. Session モデルと状態機械（Closeを明確化）

### 9.1 Session フィールド（推奨）
- `session_id: string`
- `owner: bech32`（alice）
- `executor: bech32`（local-admin）
- `root_proof: string`（hex）
- `fragment_size: uint64`
- `deadline: timestamp`（推奨：session寿命の上限）
- `limits: { max_bytes, max_fragments }`（任意）
- `state: enum`
- `close_reason: enum/string`（任意）

### 9.2 状態（改訂：CLOSED追加）
| State | 説明 |
|---|---|
| INIT | session 作成直後 |
| ROOT_COMMITTED | RootProof コミット済み |
| UPLOAD_IN_PROGRESS | TUSアップロード進行中（追跡する場合） |
| UPLOADED | ZIPアップロード完了（サーバが確認） |
| DISTRIBUTING | 断片配布中 |
| FINALIZING | manifest確定処理中（任意） |
| CLOSED_SUCCESS | 正常完了として閉鎖（最終状態） |
| CLOSED_FAILED | 失敗として閉鎖（最終状態） |

### 9.3 Close の規則（必須）
- `CLOSED_*` は最終状態であり、以降は以下を **一切許可しない**：
  - DistributeBatch
  - Finalize
  - Abort
  - RootProof再コミット
  - HTTPアップロードの継続（サーバ側も拒否推奨）

- Close と同時に（推奨）：
  - session_id 固定の authz grant を revoke
  - feegrant allowance を revoke

---

## 10. CSUフロー（改訂：CloseをTxに統合）

### Phase 0：事前準備（One-time / per session）
0.1 Faucet：`local-admin -> alice`（済）  
0.2 Feegrant：`alice -> local-admin`（session寿命分）  
0.3 Authz：`alice -> local-admin`（**session_id固定**、session.deadline と同一の expiration 推奨）

### Phase 1：Session開始（Tx）
1.1 `MsgInitSession(alice)`
- 出力：`session_id`, `session_upload_token`, `deadline`（推奨）

### Phase 2：RootProof作成 & コミット（Tx）
2.1 Alice は ZIP を解凍し RootProof を計算（RootProof v1）  
2.2 `MsgCommitRootProof(session_id, root_proof)`
- state：ROOT_COMMITTED

### Phase 3：ZIPアップロード（TUS/HTTP）
3.1 Alice は TUSでZIPをチャンクアップロード（token必須）  
3.2 完了すると executor 側が ZIP を取得可能（UPLOADED とみなす）

### Phase 4：断片化 & proof生成（Executor node g / オフチェーン）
4.1 g は ZIP を取得・安全に解凍  
4.2 `fragment_size` で断片化し `(path,index,fragment_bytes)` を生成  
4.3 二段 MerkleProof を生成（verify_fragment に適合）

### Phase 5：配布（複数Tx; local-admin 実行）
5.1 `MsgDistributeBatch(session_id, batch[])` を複数回送信
- signer：local-admin
- fee：feegrant により alice
- on-chainゲート：verify_fragment（必須）
- state：DISTRIBUTING

### Phase 6：確定 & Close（Txの一環として session を閉じる）
6.1 `MsgFinalizeAndCloseSession(session_id, manifest)`
- signer：local-admin（authz session固定の範囲）
- on-chain検証：
  - session が CLOSED でない
  - manifest.root_proof == session.root_proof
  - 必要条件（全断片配布完了等）を満たす
- IBC：
  - manifest を MDSC に送信
- **Close（必須）**：
  - state を `CLOSED_SUCCESS` に遷移
  - close_reason = "SUCCESS"
  - （推奨）authz grant revoke（session_id 固定のもの）
  - （推奨）feegrant allowance revoke（alice→local-admin）

> これにより「完了後、Txの一環として session を閉じる」「authz寿命も同時に終わる」を満たす。

### Phase 7：失敗 & Close（Txの一環として session を閉じる）
アップロード失敗または中止の場合：

7.1 `MsgAbortAndCloseSession(session_id, reason)`
- signer：local-admin（authz session固定）
- reason 例：
  - "TUS_TIMEOUT"
  - "TUS_CORRUPTED"
  - "OWNER_ABORT"
  - "LIMIT_EXCEEDED"
- **Close（必須）**：
  - state を `CLOSED_FAILED` に遷移
  - close_reason = reason
  - （推奨）authz grant revoke
  - （推奨）feegrant allowance revoke

> 失敗時も同様に、Tx処理の一環として close/revoke を行う。

---

## 11. メッセージ仕様（改訂：Close統合）

### 11.1 MsgInitSession
- `owner`（alice）
- `fragment_size`
- `limits`（任意）
- `deadline`（推奨：チェーン側で決定し保存）
- `executor`（固定：local-admin）
- 出力：`session_id`, `session_upload_token`

### 11.2 MsgCommitRootProof
- `session_id`
- `root_proof`（hex）
- 検証：
  - signer == session.owner
  - session.state が INIT/ROOT_COMMITTED（再コミット可否は設計次第。推奨：一回のみ）
  - hex妥当性

### 11.3 MsgDistributeBatch
- `session_id`
- `items[]`：
  - `path`
  - `index`
  - `fragment_bytes`
  - `fragment_proof`
  - `file_size`
  - `file_proof`
  - （任意）`target_fdsc_channel`
- 検証（必須）：
  - signer == local-admin
  - session.state が CLOSED_* でない
  - authz が session_id 固定で有効
  - verify_fragment(root_proof, ...) が真
  - (path,index) の重複拒否
  - limits 超過拒否

### 11.4 MsgFinalizeAndCloseSession（新）
- `session_id`
- `manifest`（root_proof/files/mappings/fragment_size 等）
- 検証（必須）：
  - signer == local-admin
  - session が CLOSED でない
  - authz が session_id 固定で有効
  - manifest.root_proof == session.root_proof
  - 配布完了条件（設計に応じて：期待断片数/ACK等）
- 処理：
  - MDSCへ IBC で manifest 送信
  - **state = CLOSED_SUCCESS**
  - **authz revoke（推奨）**
  - **feegrant revoke（推奨）**

### 11.5 MsgAbortAndCloseSession（新）
- `session_id`
- `reason`
- 検証（必須）：
  - signer == local-admin
  - session が CLOSED でない
  - authz が session_id 固定で有効（または signer=local-admin を特例許可する設計も可）
- 処理：
  - **state = CLOSED_FAILED**
  - **authz revoke（推奨）**
  - **feegrant revoke（推奨）**
  - （任意）TUSストレージ上のアップロード資材をGC対象へ

---

## 12. Authz/Feegrant の「寿命一致」要件（Normative）

CSUは以下を満たさなければならない：

1) **Sessionが閉じたら、以後の配布/確定/中止メッセージは必ず拒否される**  
   - これにより、Authz が残存しても実効的に無効（寿命一致）

2) **FinalizeAndClose / AbortAndClose のTx処理内で、可能な限り authz grant を revoke する**（推奨）  
   - session_id 固定の grant を確実に撤去

3) **同Tx処理内で feegrant allowance も revoke する**（推奨）  
   - ガス支払い権限の残存を防ぐ

4) **grant/allowance の expiration を session.deadline と同一にする**（最低限の保険）

---

## 13. エラーコード（改訂：Close関連追加）

| Code | 意味 |
|---|---|
| CSU_ERR_SESSION_CLOSED | session が CLOSED_* のため拒否 |
| CSU_ERR_UNAUTHORIZED | authz不備 / signer不正 |
| CSU_ERR_INVALID_PROOF | MerkleProof 検証失敗 |
| CSU_ERR_ROOTPROOF_MISMATCH | root_proof 不一致 |
| CSU_ERR_DUPLICATE_FRAGMENT | (path,index) 二重登録 |
| CSU_ERR_LIMIT_EXCEEDED | 上限超過 |
| CSU_ERR_TUS_AUTH_FAILED | TUS 認可失敗 |
| CSU_ERR_TUS_TIMEOUT | TUS期限超過 |
| CSU_ERR_FINALIZE_CONDITION | 配布完了条件を満たさない |

---

## 14. 監査（第三者検証）手順（要約）

1) GWC から `session_id` の `root_proof` / `owner` / `state` を取得  
2) `state == CLOSED_SUCCESS` を確認（成功完了として閉鎖されている）  
3) MDSC から manifest を取得し、FDSC から fragment を復元  
4) RootProof v1 で再計算し一致確認  
5) 不一致なら改ざん/欠落/不整合を検出

---

## 15. 変更履歴（この改訂で追加した点）
- **完了/失敗時に、Txの一環として session を閉じる**（CLOSED_SUCCESS / CLOSED_FAILED）
- **Authz の寿命を session の寿命と一致**させる（closeで無効化、可能ならrevokeも同Tx内で実施）
- Close統合Msg：`MsgFinalizeAndCloseSession` / `MsgAbortAndCloseSession` を追加
- Feegrant も可能なら同Tx内で revoke（寿命一致を強化）

---
