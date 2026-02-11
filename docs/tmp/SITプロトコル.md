# Session-style Inter-chain Transfer（SIT）Protocol Specification v1.0（Reconstructed + Patched）

本仕様書は、チェーンA（送信元）からチェーンB（送信先）へ **大容量データを“チェーン間二重複製なし”で配送**するための、セッション型チェーン間通信プロトコル **SIT v1.0** を規定する。

本v1.0（Patched）は以下を特徴とする：
- データ本体（chunk）は **Bチェーンにのみ永続化**し、Aチェーンには残さない
- セッション開始・完了確認は **暗号学的証明（membership proof）** と送信者署名で行う
- 配送者・リレイヤ・ノードを信用しない（ノード・フルトラストレス）
- permissionless な Import / Relay を許しつつ、送信者sequenceのreplay耐性を **“焼却不能”** にする（10.7）
- **Light Clientが指すチェーン同一性（chain_id）を必ず拘束**し、なりすまし／client差替えリプレイを防ぐ（9.6/10.1）

---

## 0. 規範表現

- **MUST**：実装は必ず満たさなければならない
- **MUST NOT**：実装は満たしてはならない
- **SHOULD**：特段の理由がない限り満たすべき
- **MAY**：実装が選択してよい

本仕様書は曖昧性排除のため、MAY/SHOULDの使用を最小化し、相互運用に必要な挙動はMUSTで固定する。

---

## 1. 目的（必須要件）

SIT v1.0は、次の原則を **すべて満たす**。

1) 送信元チェーンAにデータ本体（chunk）を残さない  
2) 送信先チェーンBにのみ、履歴またはステートとしてデータ本体を永続的に残す  
3) 秘密鍵交換・共有鍵生成を一切行わない  
4) ノード・リレイヤ・配送者を信用しない（ノード・フルトラストレス）  
5) 高速（高スループット）である  
6) 大データについて、チェーン間の冗長なブロードキャスト複製・二重保管を最小化する  
7) 暗号学的に安全（改ざん不可または確実に検知）である  
8) 配送完了（Bへの永続化完了）をAが“小さなデータ（AckRecord）”で検証できる（大データの返送禁止）

### 1.1 「永続（persistent）」の定義（固定）

本仕様書における「永続」とは次を指す（MUST）：
- データ本体がBチェーンのトランザクション本文としてブロックに取り込まれ、Bチェーンのブロックデータとして管理されること。

---

## 2. 脅威モデル（固定）

- 配送者（第三者）・リレイヤ・任意ノードは悪意を持ち得る（改ざん、欠落、順序入替、スパム）。
- Bチェーンは、Aチェーン由来メタ情報について暗号学的証明により独立検証する（ノード信用禁止）。
- データ可用性（必ず届く）を暗号だけで保証しない（ライブネス妨害は可能）。ただし改ざんはBが必ず検知する。

### 2.1 時刻 `now_ns(chain)`（決定性のため固定）

`now_ns(chain)` は **当該Txが実行されるブロックの Header.Time を Unix epoch ns に換算した値** とする（MUST）。  
ローカル壁時計を用いてはならない（MUST NOT）。

---

## 3. 全体アーキテクチャ（2プレーン＋Ack）

### 3.1 Control Plane（小メタ・証明）
- Aはセッション開始に必要な **小メタ情報（root・パラメータ・送信者署名）** のみをオンチェーンに記録する。
- Bは、Aのオンチェーン記録が存在することを membership proof により検証してセッションを開く。

### 3.2 Data Plane（大容量本体）
- データ本体は **Bにのみ** 永続化される。
- A側に本体を載せる等の冗長複製は仕様として禁止（目的6）。

### 3.3 Ack Plane（小Ack・証明）
- Bは終端時に **AckRecord（小メタ）** をBのstateに保存する（12.3）。
- AはBのAckRecordの存在を membership proof により検証し、結果を記録する（9.6）。

---

## 4. 用語

- **chunk**：データ本体の分割片（最大 `MaxChunkSize`）
- **session**：複数chunkを一つのrootで束ねる配送単位
- **SAS（Session Approval Signature）**：送信者がセッション内容（root含む）を承認した署名
- **sender**：送信者（公開鍵で識別）
- **importer**：Aのセッション記録の証明をBに持ち込むTx送信者（第三者可）
- **relay**：chunkをBに投稿するTx送信者（第三者可）
- **ack importer**：BのAckRecordの証明をAに持ち込むTx送信者（第三者可）
- **skip**：送信者が「未使用のsender_sequence範囲を破棄」してB側sequence進行を助ける宣言（10.8）

---

## 5. 暗号・エンコード（固定）

### 5.1 定数
- `PREFIX = b"SITv1"`（ASCII bytes）
- `H(x) = SHA-256(x)`（32 bytes）

### 5.2 整数・文字列（決定的エンコード）

- `u32be(x)`：4バイト big-endian 符号なし整数（0 ≤ x < 2^32）
- `u64be(x)`：8バイト big-endian 符号なし整数（0 ≤ x < 2^64）
- `ASCII(s)`：文字列 `s` をASCIIバイト列へ（**0x20〜0x7E**、長さ上限はパラメータで規定）
- `lp(b)`：`u32be(len(b)) || b`
- `lpstr(s)`：`lp(ASCII(s))`

**禁止（MUST NOT）**
- Unicode正規化やUTF-8は使用しない（曖昧性排除のためASCII固定）。
- 可変長整数（varint）を署名対象の決定的エンコードに使用しない。

### 5.2.1 識別子文字集合（追加固定）
チェーンID・クライアントID等、**識別子文字列**は次を満たす（MUST）：
- 文字集合：`[A-Za-z0-9._-]+`（スペース禁止）
- 先頭末尾スペース禁止（上の集合により自動的に禁止）
- 長さは各パラメータ上限以下（例：MaxChainIdLen, MaxClientIdLen）

この規則に違反する場合、当該レコードは「形式不正」として扱う（Import系は *_BAD_*_RECORD_FORMAT）。

### 5.3 公開鍵・署名（鍵交換なし、固定）
- 公開鍵：secp256k1 compressed public key（33 bytes）
- 署名：ECDSA(secp256k1) 固定長 `sig64 = r(32) || s(32)`（big-endian）
- malleability対策：low-s を MUST（`1 ≤ s ≤ floor(n/2)`）
- `r` は `1 ≤ r < n` を MUST
- 署名/検証は `SHA-256(message_bytes)` に対して行う（raw署名・二重ハッシュは MUST NOT）
- 公開鍵は曲線上の正当な点でなければならない（無効点は失敗、MUST）

検証関数：
- `VerifySig(pubkey33, sig64, message_bytes) -> bool`

### 5.4 sender_id
- `sender_id20 = Trunc20(H(pubkey33))`（先頭20 bytes）

---

## 6. チェーン識別子（曖昧性排除）

- `src_chain_id`：AのチェーンID（5.2.1適用、長さ ≤ `MaxChainIdLen`）
- `dst_chain_id`：BのチェーンID（5.2.1適用、長さ ≤ `MaxChainIdLen`）

Aは `src_chain_id == A.chain_id` を MUST 検証する（9.4/9.5）。  
Bは `dst_chain_id == B.chain_id` を MUST 検証する（10.4）。

---

## 7. セッション（Session）定義（固定）

### 7.1 セッションパラメータ（SIT v1.0）
すべて必須（MUST）。

- `src_chain_id: string`
- `dst_chain_id: string`
- `sender_pubkey: bytes[33]`
- `sender_id: bytes[20]`（=Trunc20(SHA-256(pubkey33))、一致検証）
- `sender_sequence: u64`（送信者単位の単調増加；Aで強制）
- `session_salt: bytes32`（送信者生成ランダム）
- `chunk_size: u32`（1 ≤ chunk_size ≤ MaxChunkSize）
- `chunk_count: u32`（1 ≤ chunk_count ≤ MaxChunkCountPerSession）
- `total_size: u64`（0は未指定、指定時は厳密一致）
- `root: bytes32`（Merkle root）
- `timeout_timestamp_ns: u64`（必須、0禁止、Unix epoch ns）
- `accept_mode: enum`
  - `MODE_WINDOWED = 1`
  - `MODE_IN_ORDER  = 2`
- `window_w: u32`
  - MODE_WINDOWED：1 ≤ window_w ≤ MaxWindowSizeW
  - MODE_IN_ORDER：window_w = 0
- `session_id: bytes32`（7.2で導出）
- `sig_session: bytes[64]`（7.3で署名）

### 7.2 session_id（循環依存排除）
session_id は root を入力に含めない（MUST）。

session_id = H(
  PREFIX || b"\x00" || b"sid" || b"\x00" ||
  lpstr(src_chain_id) ||
  lpstr(dst_chain_id) ||
  lp(sender_pubkey) ||
  lp(sender_id) ||
  u64be(sender_sequence) ||
  session_salt
)

### 7.3 SAS（セッション承認署名）

open_session_bytes =
  PREFIX || b"\x00" || b"open_session" || b"\x00" ||
  session_id ||
  root ||
  u32be(chunk_size) || u32be(chunk_count) || u64be(total_size) ||
  u64be(timeout_timestamp_ns) ||
  u32be(accept_mode) || u32be(window_w) ||
  lpstr(src_chain_id) || lpstr(dst_chain_id) ||
  lp(sender_pubkey) || lp(sender_id) ||
  u64be(sender_sequence) ||
  session_salt

sig_session = Sign(sender_privkey, open_session_bytes)

Bは MUST：
- `sender_id == Trunc20(H(sender_pubkey))`
- `VerifySig(sender_pubkey, sig_session, open_session_bytes) == true`

---

## 8. データ平面：chunk とMerkle（固定）

### 8.1 chunk分割
- indexは0-index：`i ∈ [0, chunk_count-1]`
- `len(chunk_i) ≤ chunk_size` を MUST
- `total_size != 0` の場合、最終確定時に `received_bytes == total_size` を MUST

### 8.2 leaf hash（index/len混入、セッション束縛）
leaf_i = H(
  PREFIX || b"\x00" || b"leaf" || b"\x00" ||
  session_id ||
  u32be(i) ||
  u32be(len(chunk_i)) ||
  chunk_i
)

### 8.3 Merkle tree（固定深さ完全二分木、2冪まで空パディング）
node(left, right) = H(PREFIX || b"\x00" || b"node" || b"\x00" || left || right)
E0 = H(PREFIX || b"\x00" || b"empty_leaf" || b"\x00")
P = next_pow2(chunk_count)
depth = log2(P)

root計算：
- i < chunk_count：L[i]=leaf_i、i≥chunk_count：L[i]=E0
- depth回のペア結合で唯一要素がroot

### 8.4 Merkle proof（固定深さ）
- `merkle_proof: bytes32[]`（leaf側→root側の sibling 配列）
- 長さは常に depth
- 検証は本仕様の 8.4アルゴリズムで MUST 実施

Bは `depth ≤ MaxProofDepth` を MUST。

---

## 9. チェーンA（送信元）モジュール仕様（chunk保持禁止）

### 9.1 Aの状態（state）
Aは以下のKVを保持（MUST）。

- `SeqA[sender_id20] = next_sequence(u64)`（初期0）
- `OpenA[key_open] = OpenSessionRecordBytes`
- `SkipA[key_skip] = SkipRecordBytes`
- `ResultA[key_result] = ResultRecordBytes`（9.6：terminal結果）
- （任意だが推奨）`OpenExpiryIndexA[bucket(timeout_timestamp_ns)] = ordered_set(session_id)`（9.7）

Aは **chunk本体をstateに保存してはならない（MUST NOT）**。

### 9.2 Openキー（固定）
- `KEY_OPEN_PREFIX = b"sit/open/"`
- `key_open = KEY_OPEN_PREFIX || session_id`

### 9.3 OpenSessionRecord（Aに保存する小メタ、固定バイト列）
OpenSessionRecordBytes =
  PREFIX || b"\x00" || b"open_record" || b"\x00" ||
  session_id ||
  root ||
  u32be(chunk_size) || u32be(chunk_count) || u64be(total_size) ||
  u64be(timeout_timestamp_ns) ||
  u32be(accept_mode) || u32be(window_w) ||
  lpstr(src_chain_id) || lpstr(dst_chain_id) ||
  lp(sender_pubkey) || lp(sender_id) ||
  u64be(sender_sequence) ||
  session_salt ||
  lp(sig_session)

Aは保存時に `len(sig_session)==64` を MUST 検証。

### 9.4 MsgOpenSession（AへのTx、chunkなし）
Fields：7.1一式（session_idは入力可だがAで再計算し一致必須）

Aの処理（MUST、順序固定）：
1) `src_chain_id/dst_chain_id` が 5.2.1 を満たし、長さ ≤ MaxChainIdLen
2) **`src_chain_id == A.chain_id`**
3) `timeout_timestamp_ns != 0`
4) `timeout_timestamp_ns > now_ns(A)`
5) `timeout_timestamp_ns <= now_ns(A) + MaxSessionLifetimeNsA`
6) chunk_size/chunk_count/total_size 上限、accept_mode/window_w妥当性
7) `sender_id == Trunc20(H(sender_pubkey))`
8) `session_id_calc` を7.2で導出し一致
9) `VerifySig(sender_pubkey, sig_session, open_session_bytes) == true`
10) `sender_sequence == SeqA[sender_id]`
11) `OpenA[key_open]` 未存在
12) `OpenA[key_open] = OpenSessionRecordBytes` 保存
13) `SeqA[sender_id] += 1`
14) （任意だが推奨）`OpenExpiryIndexA[bucket(timeout_timestamp_ns)]` に session_id追加

Aは上記以外の副作用を持ってはならない（MUST NOT）。

### 9.5 Skip（送信者sequence未使用範囲の破棄宣言）

#### 9.5.1 Skipキー（固定）
- `KEY_SKIP_PREFIX = b"sit/skip/"`
- `key_skip = KEY_SKIP_PREFIX || sender_id20 || u64be(from_sequence)`

#### 9.5.2 skip_bytes（署名対象）
skip_bytes =
  PREFIX || b"\x00" || b"skip_seq" || b"\x00" ||
  lpstr(src_chain_id) || lpstr(dst_chain_id) ||
  lp(sender_pubkey) || lp(sender_id) ||
  u64be(from_sequence) ||
  u32be(skip_count) ||
  skip_salt

#### 9.5.3 SkipRecordBytes
SkipRecordBytes =
  PREFIX || b"\x00" || b"skip_record" || b"\x00" ||
  lp(skip_bytes) ||
  lp(sig_skip)

#### 9.5.4 MsgSkipSequence（AへのTx）
Fields：
- `src_chain_id, dst_chain_id`
- `sender_pubkey(33), sender_id(20)`
- `from_sequence(u64), skip_count(u32), skip_salt(bytes32), sig_skip(64)`

Aの処理（MUST、順序固定）：
1) `src_chain_id/dst_chain_id` が 5.2.1 を満たし、長さ ≤ MaxChainIdLen
2) **`src_chain_id == A.chain_id`**
3) `sender_id == Trunc20(H(sender_pubkey))`
4) `1 ≤ skip_count ≤ MaxSkipCount`
5) `from_sequence == SeqA[sender_id]`
6) `VerifySig(sender_pubkey, sig_skip, skip_bytes) == true`
7) `SkipA[key_skip]` 未存在
8) `SkipA[key_skip] = SkipRecordBytes` 保存
9) `SeqA[sender_id] += u64(skip_count)`

### 9.6 Ack受領（B終端をAが証明付きで取り込む）

#### 9.6.1 必須インタフェース（Aが提供、MUST）
Aは次を提供しMUST準拠する（SITは **IBC-style Light Client + ICS23** を前提）：

- `VerifyDestMembership(dst_client_id, expected_dst_chain_id, proof_height, key_bytes, value_bytes, membership_proof_bytes) -> bool`

MUST要件：
- `dst_client_id` が指す Light Client の chain_id が `expected_dst_chain_id` に一致することを検証する（チェーン同一性拘束）。
- `proof_height` におけるBの合意済み state root（app_hash等）に対して `key_bytes -> value_bytes` の存在を暗号学的に検証する。
- 外部ノードの証言を信じてはならない（MUST NOT）。

#### 9.6.2 Resultキー（固定）
- `KEY_RESULT_PREFIX = b"sit/result/"`
- `key_result = KEY_RESULT_PREFIX || session_id`

#### 9.6.3 MsgImportAck（AへのTx：Ack取り込み、permissionless）
Fields（必須）：
- `dst_client_id: string`（5.2.1、長さ≤MaxClientIdLen）
- `proof_height: u64`
- `session_id: bytes32`
- `key_ack: bytes`（固定：`b"sit/ack/" || session_id`）
- `value_ack: bytes`（AckRecordBytes、12.3）
- `membership_proof: bytes`

Aの検証（MUST、順序固定、失敗時state更新禁止）：
1) `dst_client_id` が 5.2.1 を満たし、長さ ≤ MaxClientIdLen
2) `key_ack == b"sit/ack/"||session_id`
3) `value_ack` を 12.3 の形式としてパース（prefix/タグ一致、長さ整合、識別子は5.2.1に適合）
4) `value_ack.session_id == session_id`
5) `value_ack.src_chain_id == A.chain_id`
6) `OpenA[b"sit/open/"||session_id]` が存在し、OpenRecordと以下が一致：
   - `root`
   - `sender_pubkey`
   - `sender_id`
   - `sender_sequence`
   - `dst_chain_id`
7) **`value_ack.dst_chain_id == OpenRecord.dst_chain_id`**（宛先同一性）
8) `VerifyDestMembership(dst_client_id, value_ack.dst_chain_id, proof_height, key_ack, value_ack, membership_proof) == true`
9) `ResultA[key_result]` 未存在（重複禁止）
10) `ResultA[key_result] = ResultRecordBytes` 保存
11) （推奨）`OpenA[b"sit/open/"||session_id]` を削除してクリーニング

ResultRecordBytes（決定的、MUST）：
ResultRecordBytes =
  PREFIX || b"\x00" || b"result_record" || b"\x00" ||
  session_id ||
  u32be(value_ack.terminal_status_code) ||
  u64be(value_ack.terminal_timestamp_ns) ||
  u64be(value_ack.terminal_height) ||
  value_ack.root ||
  u64be(value_ack.received_bytes) ||
  lp(value_ack.sender_id) || lp(value_ack.sender_pubkey) ||
  u64be(value_ack.sender_sequence) ||
  lpstr(value_ack.src_chain_id) || lpstr(value_ack.dst_chain_id)

Aは配送完了の判定を `terminal_status_code==FINALIZED` により行う（MUST）。

### 9.7 A側Openレコードの期限掃除（資源上限制御、推奨→MUST）
Aが OpenA を無制限に保持しないため、Aは以下のパラメータを持つ（MUST）：
- `OpenRetentionNsA: u64`（>0）
- `ExpiryIndexTimeBucketSizeNsA: u64`（>0）
- `MaxExpiryWorkPerBlockA: u32`

AはEndBlockで、`now_ns(A) >= timeout_timestamp_ns + OpenRetentionNsA` を満たす `OpenA` を最大 `MaxExpiryWorkPerBlockA` 件削除する（MUST）。  
全走査を避けるため、`OpenExpiryIndexA[bucket(timeout_timestamp_ns)] = ordered_set(session_id)` を用いること（MUST）。  
処理継続のためのカーソル `ExpiryCursorA`（最後に処理したbucketとsession_id）を state として保持し、決定的に再開する（MUST）。

---

## 10. チェーンB（送信先）モジュール仕様（ノード・フルトラストレス）

### 10.1 Bが要求する証明（Source Membership Proof）

#### 10.1.1 必須インタフェース（Bが提供、MUST）
Bは次を提供しMUST準拠する（**IBC-style Light Client + ICS23** を前提）：

- `VerifySourceMembership(src_client_id, expected_src_chain_id, proof_height, key_bytes, value_bytes, membership_proof_bytes) -> bool`

MUST要件：
- `src_client_id` が指す Light Client の chain_id が `expected_src_chain_id` に一致することを検証する（チェーン同一性拘束）。
- `proof_height` におけるAの合意済み state root（app_hash等）に対して `key_bytes -> value_bytes` の存在を暗号学的に検証する。
- 外部ノードの証言を信じてはならない（MUST NOT）。

### 10.1.2 SITストアとCommitment Path（相互運用固定）
SITモジュールは各チェーンで **KVStore名（storeKey）=`"sit"`** を用いる（MUST）。  
membership proof は、`"sit"` ストア内の `key_bytes -> value_bytes` の存在を、当該チェーンの `app_hash` に対して検証できる形式でなければならない（MUST）。  
（Cosmos/CometBFT系では、IBC/ICS23が用いる `MerkleProof`/`ExistenceProof` と同等の検証が可能であること。）

### 10.2 Bの状態（state）
Bは以下のKVを保持（MUST）。

- `SessionB[session_id] = SessionState`（OPEN/RECEIVING中のみ）
- `TombstoneB[session_id] = Tombstone`（一定期間）
- `AckB[key_ack] = AckRecordBytes`（一定期間、12.3）
- **`SenderSeqB[(src_chain_id, sender_id20)] = SenderSeqState`（削除禁止、10.7）**
- **`SeqToSessionB[(src_chain_id, sender_id20, sender_sequence)] = session_id`（予約中のみ）**
- **`SenderKnownB[(src_chain_id, sender_id20)] = bool`（削除禁止、課金判定）**
- `ExpiryIndexB[bucket(timeout_timestamp_ns)] = ordered_set(session_id)`
- `ExpiryCursorB = (bucket, session_id)`（12.6）
- `OpenCountersB`（10.6）
- `SenderRecordsGlobal: u32`（SenderKnown総数、13/15整合のためMUST）
- `NewSenderRecordsInBlock: u32`（BeginBlockで0にリセット、13/15整合のためMUST）

**削除禁止（MUST NOT）**
- `SenderSeqB` は削除してはならない。
- `SenderKnownB` は削除してはならない。

### 10.3 declared_total（上限評価の統一定義）
- `total_size != 0`：`declared_total = total_size`
- `total_size == 0`：`declared_total = u64(chunk_count) * u64(chunk_size)`

Bの上限制約は必ず declared_total を用いる（MUST）。

### 10.4 MsgImportSession（BへのTx：セッション開始、permissionless）

Fields（必須）：
- `src_client_id: string`（5.2.1、長さ≤MaxClientIdLen）
- `proof_height: u64`
- `session_id: bytes32`
- `key_open: bytes`（固定：`b"sit/open/" || session_id`）
- `value_open: bytes`（OpenSessionRecordBytes、9.3）
- `membership_proof: bytes`
- `new_sender_bond_paid: u128`

固定キー定義：
- `key_open = b"sit/open/" || session_id`

Bの検証（MUST、順序固定、失敗時state更新禁止）：
1) `src_client_id` が 5.2.1 を満たし、長さ ≤ MaxClientIdLen
2) `key_open` が固定形式と一致
3) `value_open` を 9.3 形式としてパース（prefix/タグ一致、長さ整合、識別子は5.2.1に適合）
4) `value_open.session_id == session_id`
5) `value_open.dst_chain_id == B.chain_id`
6) `value_open.src_chain_id` 長さ ≤ MaxChainIdLen
7) **`VerifySourceMembership(src_client_id, value_open.src_chain_id, proof_height, key_open, value_open, membership_proof) == true`**
8) `sender_id == Trunc20(H(sender_pubkey))`
9) `session_id_calc` を7.2で導出し一致
10) `VerifySig(sender_pubkey, sig_session, open_session_bytes) == true`
11) `timeout_timestamp_ns > now_ns(B)`
12) `timeout_timestamp_ns <= now_ns(B) + MaxSessionLifetimeNsB`
13) chunk_size/chunk_count/window_w/depth/declared_total の上限検証
14) `TombstoneB[session_id]` が存在するなら拒否
15) `SessionB[session_id]` が存在するなら拒否
16) 初回sender登録課金（MUST）：
    - `k_sender = (value_open.src_chain_id, sender_id20)`
    - `SenderKnownB[k_sender] == false` の場合：
      - `new_sender_bond_paid == NewSenderBondAmount`（厳密一致）
      - `SenderRecordsGlobal < MaxSenderRecordsGlobal`（超過は PARAM_LIMIT）
      - `NewSenderRecordsInBlock < MaxNewSenderRecordsPerBlock`（超過は PARAM_LIMIT）
    - `SenderKnownB[k_sender] == true` の場合：
      - `new_sender_bond_paid == 0`（過払い禁止）
17) OpenCounters/Inflight等の上限制約（14.3）を検証
18) sender_sequence受理（10.7の規則で検証、read-only）：
    - window範囲内
    - done/resv未使用
    - `SeqToSessionB[...]` 未存在
19) 成功時のstate作成（MUST）：
    - `SessionB[session_id] = SessionState(OPEN, next=0, received_count=0, received_bytes=0, ..., sender_sequence, sender_id, sender_pubkey, src_client_id, src_chain_id=value_open.src_chain_id, root, timeout_timestamp_ns, ...)`
    - MODE_WINDOWED：ring-bitset初期化（11.3）
    - sender_sequence予約確定（10.7.5）＋ `SeqToSessionB` 登録
    - `SenderKnownB[k_sender] = true`（初回のみ）
    - 初回なら `SenderRecordsGlobal += 1`、`NewSenderRecordsInBlock += 1`
    - `ExpiryIndexB[bucket(timeout_timestamp_ns)]` に session_id追加
    - OpenCounters更新（10.6）

Bは失敗理由を決定的に返すため、エラーコードを15章に従い選択（MUST）。

### 10.5 MsgCancelSession（BへのTx：セッション中止）
Fields（必須）：
- `session_id: bytes32`
- `sig_cancel: bytes[64]`

cancel_bytes =
  PREFIX || b"\x00" || b"cancel_session" || b"\x00" || session_id

Bの処理（MUST、順序固定）：
1) `SessionB[session_id]` が存在し `status ∈ {OPEN, RECEIVING}`
2) `VerifySig(SessionB.sender_pubkey, sig_cancel, cancel_bytes) == true`
3) `ABORTED` とみなし、同一Tx内でクリーニング（12.2）

### 10.6 OpenCounters（必須）
Bは以下を保持（MUST）：
- `OpenSessionsGlobal: u32`
- `OpenSessionsByClient[src_client_id]: u32`
- `OpenSessionsBySender[(src_chain_id,sender_id20)]: u32`

更新（MUST）：
- Import成功で +1
- クリーニング（12.2）で -1

---

## 10.7 SenderSequence Window（permissionless importerでも焼却不能、MUST）

### 10.7.1 目的
permissionless importer により大きいsender_sequenceのセッションが先にImportされても、
過去の正当セッションが永久Import不能（焼却）にならないようにする。

### 10.7.2 SenderSeqState（B state）
キー `k = (src_chain_id, sender_id20)` ごとに保持（MUST）：

- `base_seq: u64`
- `w: u32`（=SeqWindowW、>0）
- `ring_head: u32`
- `done_bitset: bytes`（ceil(w/8)、LSB-first）
- `resv_bitset: bytes`（ceil(w/8)、LSB-first）

補助：
- `SeqToSessionB[(src_chain_id, sender_id20, sender_sequence)] = session_id`（予約中のみ）

初期値（MUST）：
- 初回作成時：`base_seq=0`, `ring_head=0`, `w=SeqWindowW`, bitset all-0

### 10.7.3 bit位置計算（MUST）
`delta = sender_sequence - base_seq`（前提：sender_sequence >= base_seq）  
`pos = (ring_head + u32(delta)) mod w`  
`byte = pos/8`, `bit=pos%8`, `mask=(1<<bit)`（LSB-first）

未使用判定（MUST）：
- done = ((done_bitset[byte] & mask) != 0)
- resv = ((resv_bitset[byte] & mask) != 0)
- 未使用は done==false && resv==false

### 10.7.4 Import時の受理条件（MUST）
1) `sender_sequence >= base_seq`
2) `sender_sequence < base_seq + u64(w)`（オーバーフロー禁止）
3) 未使用スロット
4) `SeqToSessionB[...]` 未存在

### 10.7.5 予約確定（MUST）
Import成功時のみ：
- `resv_bitset[pos] |= mask`
- `SeqToSessionB[...] = session_id`

### 10.7.6 終端確定（MUST）
セッション終端（FINALIZED/ABORTED/EXPIRED）時、12.2内で必ず：
1) pos算出
2) `resv_bitset[pos]` を0
3) `done_bitset[pos]` を1
4) `SeqToSessionB[...]` を削除

### 10.7.7 base前進（advance、MUST）
終端確定後、繰り返す（MUST）：
- ring_head位置が done==true なら、そのdone bitを0に戻し、`base_seq +=1`、`ring_head=(ring_head+1) mod w`
- done==false なら停止

---

## 10.8 MsgImportSkip（BへのTx：Skip取り込み）

Fields（必須）：
- `src_client_id: string`
- `proof_height: u64`
- `sender_id20: bytes[20]`
- `from_sequence: u64`
- `key_skip: bytes`（固定：`b"sit/skip/"||sender_id20||u64be(from_sequence)`）
- `value_skip: bytes`（SkipRecordBytes、9.5.3）
- `membership_proof: bytes`

Bの検証（MUST、順序固定、失敗時state更新禁止）：
1) `src_client_id` が 5.2.1 を満たし、長さ ≤ MaxClientIdLen
2) `key_skip` が固定形式と一致
3) `value_skip` を9.5.3形式としてパース（prefix/タグ一致、長さ整合、識別子は5.2.1に適合）
4) skip_bytes復元し検証：
   - `skip_bytes.dst_chain_id == B.chain_id`
   - `skip_bytes.sender_id == sender_id20`
5) **`VerifySourceMembership(src_client_id, skip_bytes.src_chain_id, proof_height, key_skip, value_skip, membership_proof) == true`**
6) `VerifySig(sender_pubkey, sig_skip, skip_bytes) == true`
7) `k = (skip_bytes.src_chain_id, sender_id20)` の `SenderSeqB[k]` を取得（未登録なら初期化）
8) `from_sequence == SenderSeqB[k].base_seq`
9) `1 ≤ skip_count ≤ MaxSkipCount` かつ `u64(skip_count) ≤ u64(w)`
10) 対象範囲に予約(resv_bitset==1)が存在するなら拒否
11) 成功時更新（MUST）：
    - 先頭から skip_count 個を done=1 に設定し、advance（10.7.7）

---

## 11. Bでのchunk受理（permissionless、改ざん検知）

### 11.1 MsgRelayChunk（BへのTx）
Fields（必須）：
- `session_id: bytes32`
- `index: u32`
- `chunk: bytes`
- `merkle_proof: bytes32[]`

### 11.2 前処理（MUST、順序固定）
1) `SessionB[session_id]` が存在し `status ∈ {OPEN, RECEIVING}`
2) `now_ns(B) < timeout_timestamp_ns`
3) `index < chunk_count`
4) `len(chunk) ≤ chunk_size`
5) `depth = log2(next_pow2(chunk_count))`
6) `len(merkle_proof) == depth` かつ `depth ≤ MaxProofDepth`
7) `total_size != 0` の場合：`received_bytes + len(chunk) ≤ total_size`

ここで落ちる場合、leaf/proof計算に入ってはならない（MUST NOT）。

### 11.3 MODE_WINDOWED（リングbitset）
SessionState（MODE_WINDOWEDのみ）：
- `next: u32`, `w: u32`, `ring_head: u32`, `bitset: bytes(ceil(w/8))`

bit位置計算・受理条件・advanceは原仕様どおり（11.3.1〜11.3.3、MUST）。

### 11.4 MODE_IN_ORDER
受理条件：`index == next`（MUST）

### 11.5 Merkle検証とstate更新（共通、MUST）
受理条件を満たした場合のみ：
1) `leaf_i` を8.2で計算
2) 8.4で `cur == root` を検証（失敗は拒否）
3) 成功なら：
   - `status = RECEIVING`（初回以降）
   - `received_count += 1`
   - `received_bytes += len(chunk)`
   - WINDOWED：bitセット＋advance
   - IN_ORDER：`next += 1`

### 11.6 FINALIZED/ABORTED（MUST）
`received_count == chunk_count` で：
- `total_size != 0` なら `received_bytes == total_size` を検証
  - 不一致なら ABORTED とみなしクリーニング（12.2）
- 一致または total_size==0 なら FINALIZED とみなしクリーニング（12.2）

---

## 12. 期限・終端・クリーニング（決定性）

### 12.1 timeout判定（固定）
- `now_ns(B) >= timeout_timestamp_ns` で期限成立（MUST）

### 12.2 クリーニング（終端時に必ず実行、MUST）
終端（FINALIZED / EXPIRED / ABORTED）到達時、同一ブロック内で必ず：
1) `SessionB[session_id]` を削除
2) `TombstoneB[session_id]` を作成・保存：
   - `terminal_status ∈ {FINALIZED, EXPIRED, ABORTED}`
   - `terminal_timestamp_ns = now_ns(B)`
3) `ExpiryIndexB[bucket(timeout_timestamp_ns)]` から session_id を削除（存在時）
4) OpenCountersを減算（10.6）
5) SenderSequence終端確定（10.7.6/10.7.7）
6) AckRecord作成（12.3）し `AckB[key_ack]` に保存

### 12.3 AckRecord（B保存、MUST）

#### 12.3.1 Ackキー（固定）
- `KEY_ACK_PREFIX = b"sit/ack/"`
- `key_ack = KEY_ACK_PREFIX || session_id`

#### 12.3.2 AckRecordBytes（決定的）
terminal_status_code（MUST固定）：
- `FINALIZED = 1`
- `ABORTED   = 2`
- `EXPIRED   = 3`

AckRecordBytes =
  PREFIX || b"\x00" || b"ack_record" || b"\x00" ||
  session_id ||
  u32be(terminal_status_code) ||
  root ||
  u64be(received_bytes) ||
  u64be(sender_sequence) ||
  lpstr(src_chain_id) || lpstr(dst_chain_id) ||
  lp(sender_pubkey) || lp(sender_id) ||
  u64be(terminal_timestamp_ns) ||
  u64be(terminal_height)

`terminal_height` はBのブロック高であり、取得可能な値を設定（MUST）。

### 12.4 Tombstone保持と削除
- `TombstoneRetentionNs > 0`（MUST）
- `now_ns(B) >= terminal_timestamp_ns + TombstoneRetentionNs` で削除（MUST）
- Tombstoneが存在する session_id の Import は必ず拒否（MUST）

### 12.5 Ack保持と削除（安全下限を追加）
- `AckRetentionNs > 0`（MUST）
- `AckSafetyMarginNs > 0`（MUST）
- **`AckRetentionNs >= MaxSessionLifetimeNsB + AckSafetyMarginNs` を MUST**
- `now_ns(B) >= terminal_timestamp_ns + AckRetentionNs` で削除（MUST）

### 12.6 期限インデックス（全走査禁止、カーソル固定）
- `bucket(ts) = (ts / ExpiryIndexTimeBucketSizeNs) * ExpiryIndexTimeBucketSizeNs`
- `ExpiryIndexB[bucket]` は session_id 辞書順集合（重複禁止）

BはEndBlockで以下を MUST：
- `current_bucket = bucket(now_ns(B))`
- `ExpiryCursorB`（最後に処理したbucket/session_id）から決定的に再開し、
  bucket昇順・session_id辞書順で期限処理を進める
- 1ブロックの処理件数は `MaxExpiryWorkPerBlock` を超えない

### 12.7 資源ロック回避（観測から除外）
OpenCounters/Inflight観測において、
`now_ns(B) >= timeout_timestamp_ns` のセッションは観測対象から除外（MUST）。

---

## 13. DoS対策パラメータ（必須）

Bは以下を持つ（MUST）：

- `MaxChainIdLen: u32`
- `MaxClientIdLen: u32`
- `MaxChunkSize: u32`
- `MaxChunkCountPerSession: u32`
- `MaxTotalSizePerSession: u64`（declared_totalに適用）
- `MaxProofDepth: u32`
- `MaxWindowSizeW: u32`
- `MaxSessionLifetimeNsB: u64`
- `MaxSessionLifetimeNsA: u64`
- `TombstoneRetentionNs: u64`（>0）
- `AckRetentionNs: u64`（>0、12.5制約）
- `AckSafetyMarginNs: u64`（>0）
- `ExpiryIndexTimeBucketSizeNs: u64`（>0）
- `MaxExpiryWorkPerBlock: u32`
- `MaxOpenSessionsGlobal: u32`
- `MaxOpenSessionsPerClient: u32`
- `MaxOpenSessionsPerSender: u32`
- `MaxInflightBytesPerSender: u64`
- `NewSenderBondAmount: u128`（>0）
- `SeqWindowW: u32`（>0）
- `MaxSkipCount: u32`（>0）
- `MaxSenderRecordsGlobal: u32`
- `MaxNewSenderRecordsPerBlock: u32`

Aは以下を持つ（MUST）：
- `MaxChainIdLen: u32`
- `MaxClientIdLen: u32`
- `MaxSessionLifetimeNsA: u64`
- `MaxSkipCount: u32`
- `OpenRetentionNsA: u64`（>0）
- `ExpiryIndexTimeBucketSizeNsA: u64`（>0）
- `MaxExpiryWorkPerBlockA: u32`

---

## 14. 観測値・カウンタ（決定性、必須）

### 14.1 depth
`depth = log2(next_pow2(chunk_count))`（MUST）

### 14.2 inflight bytes
- `inflight(session) = max(0, declared_total - received_bytes)`
- 観測対象：`status ∈ {OPEN, RECEIVING}` かつ `now_ns(B) < timeout_timestamp_ns`

`observed_inflight(sender) = sum inflight(session)`（同一 sender_key=(src_chain_id,sender_id20) で合算）

### 14.3 上限制約（Import成功前に検証、MUST）
- `OpenSessionsGlobal < MaxOpenSessionsGlobal`
- `OpenSessionsByClient[src_client_id] < MaxOpenSessionsPerClient`
- `OpenSessionsBySender[(src_chain_id,sender_id20)] < MaxOpenSessionsPerSender`
- `observed_inflight(sender) + declared_total ≤ MaxInflightBytesPerSender`

---

## 15. エラーコード（決定性、必須）

### 15.1 ImportSession result_code（MUST）
- `IMPORT_SUCCESS`
- `IMPORT_FAILED_BAD_KEY_FORMAT`
- `IMPORT_FAILED_BAD_OPEN_RECORD_FORMAT`
- `IMPORT_FAILED_DST_CHAIN_MISMATCH`
- `IMPORT_FAILED_BAD_MEMBERSHIP_PROOF`
- `IMPORT_FAILED_BAD_SENDER_ID`
- `IMPORT_FAILED_BAD_SESSION_ID`
- `IMPORT_FAILED_BAD_SIG_SESSION`
- `IMPORT_FAILED_TIMEOUT_NOT_IN_FUTURE`
- `IMPORT_FAILED_LIFETIME_EXCEEDED`
- `IMPORT_FAILED_PARAM_LIMIT`
- `IMPORT_FAILED_DUPLICATE_SESSION`
- `IMPORT_FAILED_TOMBSTONED`
- `IMPORT_FAILED_BOND_REQUIRED`
- `IMPORT_FAILED_BOND_NOT_ALLOWED`
- `IMPORT_FAILED_SEQ_WINDOW`
- `IMPORT_FAILED_SEQ_ALREADY_USED`

`IMPORT_FAILED_PARAM_LIMIT` の場合、violations[] を必ず返す（MUST）。列挙順（MUST）：
1) MAX_CHAIN_ID_LEN
2) MAX_CLIENT_ID_LEN
3) MAX_CHUNK_SIZE
4) MAX_CHUNK_COUNT
5) MAX_TOTAL_SIZE
6) MAX_PROOF_DEPTH
7) MAX_WINDOW_W
8) MAX_OPEN_SESSIONS_GLOBAL
9) MAX_OPEN_SESSIONS_PER_CLIENT
10) MAX_OPEN_SESSIONS_PER_SENDER
11) MAX_INFLIGHT_BYTES_PER_SENDER
12) MAX_SENDER_RECORDS_GLOBAL
13) MAX_NEW_SENDER_RECORDS_PER_BLOCK

### 15.2 ImportSkip result_code（MUST）
- `SKIP_SUCCESS`
- `SKIP_FAILED_BAD_KEY_FORMAT`
- `SKIP_FAILED_BAD_SKIP_RECORD_FORMAT`
- `SKIP_FAILED_DST_CHAIN_MISMATCH`
- `SKIP_FAILED_BAD_MEMBERSHIP_PROOF`
- `SKIP_FAILED_BAD_SIG_SKIP`
- `SKIP_FAILED_BASE_MISMATCH`
- `SKIP_FAILED_PARAM_LIMIT`
- `SKIP_FAILED_RANGE_RESERVED`

### 15.3 RelayChunk result_code（MUST）
- `RELAY_SUCCESS`
- `RELAY_FAILED_SESSION_NOT_FOUND`
- `RELAY_FAILED_SESSION_STATUS`
- `RELAY_FAILED_TIMEOUT`
- `RELAY_FAILED_INDEX_RANGE`
- `RELAY_FAILED_WINDOW_RANGE`
- `RELAY_FAILED_ALREADY_RECEIVED`
- `RELAY_FAILED_CHUNK_SIZE`
- `RELAY_FAILED_PROOF_LENGTH`
- `RELAY_FAILED_BAD_PROOF`
- `RELAY_FAILED_TOTAL_SIZE_EXCEEDED`

### 15.4 CancelSession result_code（MUST）
- `CANCEL_SUCCESS`
- `CANCEL_FAILED_SESSION_NOT_FOUND`
- `CANCEL_FAILED_ALREADY_TERMINAL`
- `CANCEL_FAILED_BAD_SIG_CANCEL`

### 15.5 ImportAck（A側）result_code（MUST）
- `ACK_IMPORT_SUCCESS`
- `ACK_IMPORT_FAILED_BAD_CLIENT_ID`
- `ACK_IMPORT_FAILED_BAD_KEY_FORMAT`
- `ACK_IMPORT_FAILED_BAD_ACK_RECORD_FORMAT`
- `ACK_IMPORT_FAILED_OPEN_RECORD_NOT_FOUND`
- `ACK_IMPORT_FAILED_OPEN_ACK_MISMATCH`
- `ACK_IMPORT_FAILED_BAD_MEMBERSHIP_PROOF`
- `ACK_IMPORT_FAILED_DUPLICATE`

---

## 16. セキュリティ性質（保証）

### 16.1 完全性（Integrity）
chunkの改ざん・index差替え・len偽装・欠落は leaf+Merkle proof でBが検知し拒否（MUST）。

### 16.2 認証（Authenticity）
- セッション開始は sig_session により送信者承認が保証され、Bは独立検証（MUST）。
- Cancel/Skipはそれぞれの署名により送信者のみ実行可能（MUST）。

### 16.3 ノード・フルトラストレス
- Import/Ack取り込みは Verify{Source,Dest}Membership（暗号検証）で行い、外部証言に依存しない（MUST）。
- chunk受理は暗号検証のみで決定（MUST）。

### 16.4 再実行耐性（Replay）
- `session_id` 重複は Tombstone/Session存在で拒否（MUST）。
- Tombstone削除後も、`SenderSeqB[(src_chain_id,sender_id20)]` により `sender_sequence < base_seq` は永久拒否（MUST）。
- SenderSeqB/SenderKnownB は削除禁止（MUST NOT）。

### 16.5 permissionless importer による“焼却”耐性
out-of-order Import が発生しても、sender_sequence は window内未使用スロットにのみ予約されるため、過去sequenceが永久拒否されない（10.7、MUST）。

### 16.6 チェーン同一性拘束（なりすまし耐性）
Light Clientの chain_id を expected_{src,dst}_chain_id と照合するため、別チェーンのOpen/Ackを誤受理しない（9.6/10.1、MUST）。

---

## Appendix A：SITメッセージ一覧
- A：`MsgOpenSession`
- A：`MsgSkipSequence`
- A：`MsgImportAck`
- B：`MsgImportSession`
- B：`MsgRelayChunk`
- B：`MsgCancelSession`
- B：`MsgImportSkip`

---

## Appendix B：実装準拠チェックリスト（MUST）
- Aがchunk本体をstateに保存していない
- Aが `src_chain_id==A.chain_id` を強制している
- AがSeqA単調増加を必ず強制している
- AがOpenSessionRecordBytesを仕様どおり保存している
- Bが `dst_chain_id==B.chain_id` を検証している
- B/Aが Verify*Membership で **expected_chain_id を照合**している
- BがSenderSequence Window（10.7）をリングbitset定義どおり実装し、キーが `(src_chain_id,sender_id20)` である
- BがSenderSeqB/SenderKnownBを削除していない
- Bがtimeout成立セッションを観測対象から除外して資源ロックを防いでいる
- BがAckRetentionNsの安全下限制約（12.5）を満たしている
- B/AがExpiryIndex＋Cursorにより全走査なしに期限処理を実施している
- Bが終端時にAckRecordを作成し、Aが証明付きでImportできる
