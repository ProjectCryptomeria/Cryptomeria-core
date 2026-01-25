# Issue 0: CSU実装方針（互換/破壊変更）の決定とスコープ固定

**目的**: 以降のIssueで迷わないように、互換性の扱いと破壊変更点を先に確定する。

* **決めること**

  * 旧 `upload_id` と新 `session_id` は完全移行（旧Msgは非推奨エラーにする） or 旧併存（feature flag）
  * `packet.proto` の `site_root` は `root_proof` に置き換え（後方互換のため併存フィールドにする）か
  * `Executor(local-admin)` を **ハードコード**するか（genesis/paramsで保持するか）
  * 完了条件（Finalizeに必要な “配布完了”）をどう定義するか

    * A: “送信した断片数 == ACK成功数”
    * B: “(path,index) の受理済みがRootProofから導出される期待数に一致” ※期待数算出はオフチェーン前提
* **触るファイル**: なし（設計Issue）

**Acceptance**

* 互換/破壊の方針が決まり、Issue 1以降の実装が一本道になる。

---

# Issue 1: proto刷新（CSUメッセージ・型・Proof構造・Session状態）

**目的**: CSU必須のMsg/型を proto に追加し、生成コードの土台を作る。

## 変更対象

* `apps/gwc/proto/gwc/gateway/v1/tx.proto`
* `apps/gwc/proto/gwc/gateway/v1/types.proto`（または新規 `session.proto` 追加でも可）
* `apps/gwc/proto/gwc/gateway/v1/query.proto`
* `apps/gwc/proto/gwc/gateway/v1/packet.proto`

## proto差分（案）

### tx.proto（追加・置換）

* 追加:

  * `rpc InitSession(MsgInitSession) returns (MsgInitSessionResponse);`
  * `rpc CommitRootProof(MsgCommitRootProof) returns (MsgCommitRootProofResponse);`
  * `rpc DistributeBatch(MsgDistributeBatch) returns (MsgDistributeBatchResponse);`
  * `rpc FinalizeAndCloseSession(MsgFinalizeAndCloseSession) returns (...);`
  * `rpc AbortAndCloseSession(MsgAbortAndCloseSession) returns (...);`
* 旧:

  * `InitUpload/PostChunk/CompleteUpload/SignUpload` は **deprecated**（コメント）し、Issue 10で挙動を決める

### Proof表現（例）

```proto
message MerkleStep {
  string sibling_hex = 1;  // 兄弟ノードのhex
  bool   sibling_is_left = 2; // siblingがleftか（leafがrightか）
}
message MerkleProof {
  repeated MerkleStep steps = 1;
}
```

### Session型（例）

```proto
enum SessionState {
  SESSION_STATE_UNSPECIFIED = 0;
  SESSION_STATE_INIT = 1;
  SESSION_STATE_ROOT_COMMITTED = 2;
  SESSION_STATE_UPLOADED = 3;       // 追跡するなら
  SESSION_STATE_DISTRIBUTING = 4;
  SESSION_STATE_CLOSED_SUCCESS = 5;
  SESSION_STATE_CLOSED_FAILED = 6;
}

message Session {
  string session_id = 1;
  string owner = 2;        // bech32
  string executor = 3;     // local-admin
  string root_proof = 4;   // hex
  uint64 fragment_size = 5;
  int64 deadline_unix = 6;
  SessionState state = 7;
  string close_reason = 8;
  uint64 distributed_count = 9;
  uint64 ack_success_count = 10;
  uint64 ack_error_count = 11;
}
```

### Msg（例）

* `MsgInitSession { owner, fragment_size, deadline(optional), limits(optional) } -> { session_id, session_upload_token, deadline }`
* `MsgCommitRootProof { owner, session_id, root_proof_hex }`
* `MsgDistributeBatch { executor(local-admin), session_id, repeated DistributeItem items }`

  * `DistributeItem { path, index, fragment_bytes, MerkleProof fragment_proof, uint64 file_size, MerkleProof file_proof, string target_fdsc_channel(optional) }`
* `MsgFinalizeAndCloseSession { executor, session_id, ManifestPacket manifest }`
* `MsgAbortAndCloseSession { executor, session_id, reason }`

### query.proto（追加）

* `QuerySession(session_id)`
* `QuerySessionsByOwner(owner, pagination)`
* 必要なら `QuerySessionFragments(session_id)`（デバッグ用）

### packet.proto（互換方針次第）

* `FragmentPacket` に `session_id` と `root_proof` を追加（推奨：`site_root`は残す）
* `ManifestPacket` に `root_proof` を追加（推奨：`site_root`は残す）

## 触るGo側（生成反映の準備）

* `apps/gwc/x/gateway/types/*`（生成後に ValidateBasic 等をIssue 3で実装）

**Acceptance**

* `buf generate` が通り、新Msg/Session/Proof/Query/Packet型が生成される。

---

# Issue 2: KV State刷新（Session本体・断片重複防止・ACK集計・Packetマッピング）

**目的**: CSUの状態機械と `(path,index)` 重複拒否をチェーンstateで実現する。

## 変更対象

* `apps/gwc/x/gateway/types/keys.go`
* `apps/gwc/x/gateway/keeper/keeper.go`
* `apps/gwc/x/gateway/keeper/upload_session.go`（旧を置換or分離）
* （新規）`apps/gwc/x/gateway/keeper/session_store.go` 等

## state追加（collections案）

* `Sessions: Map[string, types.Session]`
* `SessionFragments: KeySet[(session_id, path, index)]` or `Map[string,bool]`（キーを `session|path|index` に文字列化でもOK）
* `PacketSeqToFragment: Map[uint64, FragmentKey]`（IBC SendPacketのsequenceをキーにしてACKで引く）
* `SessionAckCounters`（Session内に持てるなら不要）

> 重要：現状 `FragmentToSession` は fragmentID前提。CSUは `(path,index)` が主キーなので、ACK処理もそこに寄せるのが安全。

**Acceptance**

* Session作成/取得/更新がKeeperでできる
* `(path,index)` の二重登録がstateで検知できる

---

# Issue 3: Msgハンドラ分解（CSU Msg群を実装、旧uploadフローは隔離）

**目的**: `msg_server.go` をCSUメッセージ中心に作り直す。

## 変更対象

* `apps/gwc/x/gateway/keeper/msg_server.go`（分割推奨）

  * 新規:

    * `msg_init_session.go`
    * `msg_commit_root_proof.go`
    * `msg_distribute_batch.go`
    * `msg_finalize_close.go`
    * `msg_abort_close.go`
* `apps/gwc/x/gateway/types/messages_*.go`（ValidateBasic追加）
* `apps/gwc/x/gateway/types/errors.go`（CSUエラー追加）

## 実装ポイント

* `MsgInitSession`

  * `session_id` 生成（例: `owner + blockTimeNano`）
  * `executor` は **local-admin固定**（Issue 0の方針）
  * `deadline` を保存
  * `session_upload_token` 発行（tokenの実体はIssue 7で）
* `MsgCommitRootProof`

  * signer==owner
  * stateが `INIT` のみ許可（仕様推奨：一回のみ）
  * root_proof hex妥当性
  * state->`ROOT_COMMITTED`
* `MsgDistributeBatch`

  * signer==local-admin
  * sessionが `CLOSED_*` なら拒否
  * `(path,index)` 重複拒否
  * **verify_fragment**（Issue 4）
  * IBC送信（Issue 5）
  * state->`DISTRIBUTING`（初回のみ）
* `MsgFinalizeAndCloseSession`

  * signer==local-admin
  * session CLOSED拒否
  * `manifest.root_proof == session.root_proof` 必須
  * “配布完了条件”チェック（Issue 0で決めた方式）
  * MDSCへ manifest 送信（Issue 5）
  * **同Tx内で state->CLOSED_SUCCESS + revoke（Issue 6/7）**
* `MsgAbortAndCloseSession`

  * signer==local-admin
  * session CLOSED拒否
  * **同Tx内で state->CLOSED_FAILED + revoke（Issue 6/7）**

## errors.go（追加）

`CSU_ERR_SESSION_CLOSED / CSU_ERR_INVALID_PROOF / CSU_ERR_DUPLICATE_FRAGMENT / ...` を sentinel error として追加。

**Acceptance**

* 新MsgがgRPC/Txとして動き、Session stateが仕様通りに遷移する
* CLOSED後は Distribute/Finalize/Abort/Commit が拒否される

---

# Issue 4: MerkleProof検証（verify_fragment）を実装

**目的**: CSUの中核である `verify_fragment` をオンチェーンで強制する。

## 変更対象

* `apps/gwc/x/gateway/keeper/merkle_logic.go`

  * 追加: `MerkleVerifyRoot(leafHex string, proof types.MerkleProof) (rootHex string, error)`
  * 追加: `VerifyFragment(rootProofHex, path, index, fragmentBytes, fragmentProof, fileSize, fileProof) error`
* `apps/gwc/x/gateway/keeper/merkle_logic_test.go`（テスト増強）
* `apps/gwc/x/gateway/types`（Proof型が生成される前提：Issue 1）

**実装要件（仕様準拠）**

* leaf算出:

  * `leaf_frag = SHA256("FRAG:{path}:{index}:{hex(SHA256(fragment_bytes))}")`
  * `leaf_file = SHA256("FILE:{path}:{file_size}:{file_root}")`
* MerkleRoot/Verifyは「hex文字列連結をsha」
* proof steps の左右連結を `sibling_is_left` で表現する

**Acceptance**

* 正しいproofなら通り、不正proofなら `CSU_ERR_INVALID_PROOF`
* 既存 `CalculateSiteRoot` は（RootProof=SiteRootの同値として）引き続き利用可

---

# Issue 5: IBCフロー再設計（ACK駆動 publish を廃止し、FinalizeでMDSC送信）

**目的**: 現状の `ACKが揃ったら自動でmanifest送信` を、CSUの `FinalizeAndCloseSession` に集約する。

## 変更対象

* `apps/gwc/x/gateway/keeper/msg_server.go`（Distribute/Finalizeで送信）
* `apps/gwc/x/gateway/module/module_ibc.go`（ACK処理を session集計に変更）
* `apps/gwc/x/gateway/keeper/upload_session.go`（IBC waiterロジックを置換/削除）
* `apps/gwc/proto/gwc/gateway/v1/packet.proto`（必要に応じて session_id/root_proof追加）

## 設計（推奨）

* `MsgDistributeBatch` が IBCで FragmentPacket を送る

  * packetの識別は `SendPacket` の戻り `sequence` を保存してACKで引く（Issue 2の `PacketSeqToFragment`）
* `OnAcknowledgementPacket` は

  * ACK成功: session.ack_success_count++
  * ACK失敗: session.ack_error_count++（or 状態を FAIL寄りにする）
  * **manifest送信はしない**
* `MsgFinalizeAndCloseSession` が

  * MDSC channel を解決して ManifestPacket を送信
  * 同Tx内で Close + revoke

**Acceptance**

* ACKが来ても自動publishされず、Finalizeを投げない限りMDSCにmanifestが出ない
* ACKカウンタが Session に反映される

---

# Issue 6: Close処理の同Tx統合（state更新 + Authz revoke）

**目的**: 仕様の「Txの一環としてsessionを閉じる」「Authz寿命同期（論理必須＋物理推奨）」を満たす。

## 変更対象

* `apps/gwc/x/gateway/keeper/msg_finalize_close.go`（新規）
* `apps/gwc/x/gateway/keeper/msg_abort_close.go`（新規）
* `apps/gwc/x/gateway/module/depinject.go`
* `apps/gwc/x/gateway/types/expected_keepers.go`（Authz用インタフェ追加）
* `apps/gwc/x/gateway/keeper/keeper.go`（AuthzKeeperを保持）

## 実装案

* **論理的無効化（必須）**：全Msgで `CLOSED_*` を拒否（Issue 3で実施済）
* **物理的撤去（推奨）**：

  * Closeハンドラ内で authz keeper を呼び `Revoke(granter=owner, grantee=local-admin, msgTypeURLs...)`
  * revoke対象：

    * DistributeBatch / FinalizeAndClose / AbortAndClose の各msg type URL

**Acceptance**

* Close後は authz grant が残っても実効無効（論理）
* revokeが成功すれば grant が削除される（物理）

---

# Issue 7: Feegrant寿命同期（Closeでrevoke、最低限deadline expiration）

**目的**: 「ガス代はAlice負担」を前提に、Closeで費用権限も終わらせる。

## 変更対象

* `apps/gwc/x/gateway/module/depinject.go`（FeegrantKeeper注入）
* `apps/gwc/x/gateway/types/expected_keepers.go`（Feegrant用IF追加）
* `apps/gwc/x/gateway/keeper/keeper.go`（FeegrantKeeperを保持）
* `apps/gwc/x/gateway/keeper/msg_finalize_close.go`
* `apps/gwc/x/gateway/keeper/msg_abort_close.go`

## 実装案

* Closeハンドラで allowance revoke（可能なら）
* それが難しい場合でも、**InitSessionでdeadlineを決め、そのdeadlineと同じexpirationでfeegrantを要求**する運用ガイドを整備（チェーン側強制は難しい）

**Acceptance**

* Close後に feegrant が残らない（理想）
* 少なくとも expiration が deadline と一致する運用にできる（最低条件）

---

# Issue 8: Authz “session_id固定” を強制（推奨A or 最低条件B）

**目的**: 仕様の「Authzはsession_id固定」を満たす。

## 実装パターン

### A) SessionBoundAuthorization（推奨・重い）

* gateway module に `authorization.proto` を追加し `Any` 登録
* `Accept(ctx, msg)` で `msg.session_id == auth.session_id` を強制

**触る場所**

* `apps/gwc/proto/gwc/gateway/v1/authorization.proto`（新規）
* `apps/gwc/x/gateway/types/codec.go`（interface registration）
* `apps/gwc/x/gateway/module/module.go`（RegisterInterfaces）
* `apps/gwc/x/gateway/keeper/msg_*.go`（authzチェックは標準authzに任せられる）

### B) Msg側で session固定を強制（最低条件・軽い）

* `MsgDistributeBatch/Finalize/Abort` の handler で

  * signer==local-admin
  * `session.executor == local-admin`
  * `session.owner` が期待される granter と一致
  * authz grant 存在チェック（msg type単位）は keeper 経由で確認

**触る場所**

* `apps/gwc/x/gateway/keeper/msg_distribute_batch.go` 等

**Acceptance**

* local-admin が “別session” を勝手に処理できない
* sessionが閉じたら以後拒否（Issue 6と合流）

---

# Issue 9: Query追加（Session閲覧・進捗・Close理由の可視化）

**目的**: オフチェーンExecutorや監査が必要な情報をQueryで取れるようにする。

## 変更対象

* `apps/gwc/proto/gwc/gateway/v1/query.proto`
* `apps/gwc/x/gateway/keeper/query.go`
* `apps/gwc/x/gateway/module/autocli.go`（CLI追加）
* `apps/gwc/docs/static/openapi.json`（生成で更新）

**追加Query案**

* `Session(session_id)`
* `SessionsByOwner(owner, pagination)`
* `SessionsByState(state, pagination)`（運用向け）
* 必要なら `SessionStats(session_id)`（ack countersだけなど）

**Acceptance**

* REST/gRPCで session 状態、root_proof、ack数、close_reason が取れる

---

# Issue 10: 旧Uploadフローの扱い（削除 or 非推奨エラー化 or 互換維持）

**目的**: CSUへ移行しても、旧Txが中途半端に動いて事故らないようにする。

## 変更対象

* `apps/gwc/proto/gwc/gateway/v1/tx.proto`（deprecatedコメント）
* `apps/gwc/x/gateway/keeper/msg_server.go`
* `apps/gwc/x/gateway/keeper/upload_session.go`
* `apps/gwc/x/gateway/types/messages_upload.go`

## 方針例

* **推奨**：旧Msgは `ErrInvalidRequest("deprecated: use CSU")` で即拒否（後方互換不要なら最短）
* 併存するなら：

  * paramsに `enable_legacy_upload` を追加し off をデフォルト（Issue 11）

**Acceptance**

* 旧フローが意図せず使われない
* 互換維持する場合でも、CSUセッションと混線しない

---

# Issue 11: Params/limits（max_bytes, max_fragments, default_deadline）を追加

**目的**: DoS耐性と運用調整をparamsで可能にする（仕様のlimits/timeoutの受け皿）。

## 変更対象

* `apps/gwc/proto/gwc/gateway/v1/params.proto`
* `apps/gwc/x/gateway/types/params.go`
* `apps/gwc/x/gateway/keeper/msg_update_params.go`
* `apps/gwc/x/gateway/module/module.go`（default params）

**追加案**

* `max_fragment_bytes`
* `max_fragments_per_session`
* `default_deadline_seconds`
* `enable_legacy_upload`（Issue 10で使うなら）

**Acceptance**

* limits超過で `CSU_ERR_LIMIT_EXCEEDED` が返る
* deadlineがチェーン側で一貫して決まる

---

# Issue 12: テスト（verify_fragment / state machine / IBC ACK / close拒否）

**目的**: CSUの安全性の根幹（proof検証・Close）を壊さないようにする。

## 変更対象

* `apps/gwc/x/gateway/keeper/merkle_logic_test.go`（proof検証）
* 新規 `apps/gwc/x/gateway/keeper/session_test.go`（state遷移）
* 新規 `apps/gwc/x/gateway/module/ibc_ack_test.go`（ACK集計・自動publishしない）
* 既存upload関連テストがあれば移行

**Acceptance**

* 正常proof/異常proofがテストで判定できる
* `CLOSED_*` で全操作拒否がテストで保証される
* ACKが来てもmanifestが勝手に送られないことが保証される

---

## “どのファイルをどう触るか” まとめ（一覧）

* proto

  * `apps/gwc/proto/gwc/gateway/v1/tx.proto`（CSU Msg追加、旧deprecated）
  * `apps/gwc/proto/gwc/gateway/v1/types.proto`（Session/Proof/State追加）
  * `apps/gwc/proto/gwc/gateway/v1/query.proto`（Session Query追加）
  * `apps/gwc/proto/gwc/gateway/v1/packet.proto`（session_id/root_proof追加、互換維持ならsite_root併存）
  * （推奨Aなら）`authorization.proto` 新規
* keeper/state

  * `apps/gwc/x/gateway/types/keys.go`（Session/Fragment/Seq mappingキー追加）
  * `apps/gwc/x/gateway/keeper/keeper.go`（Sessions等のcollections追加、Authz/Feegrant keeper保持）
  * `apps/gwc/x/gateway/keeper/upload_session.go`（旧削除or隔離）
  * 新規 `keeper/session_store.go`（CRUD）
* keeper/handlers

  * `apps/gwc/x/gateway/keeper/msg_server.go`（分割してCSU Msg実装）
  * 新規 `msg_*.go` 5本（Init/Commit/Distribute/FinalizeClose/AbortClose）
* merkle

  * `apps/gwc/x/gateway/keeper/merkle_logic.go`（Verify追加）
* ibc

  * `apps/gwc/x/gateway/module/module_ibc.go`（ACKで集計のみ、auto publish撤去）
* DI

  * `apps/gwc/x/gateway/module/depinject.go`（Authz/Feegrant注入）
  * `apps/gwc/x/gateway/types/expected_keepers.go`（IF追加）
* query/cli

  * `apps/gwc/x/gateway/keeper/query.go`
  * `apps/gwc/x/gateway/module/autocli.go`
* errors

  * `apps/gwc/x/gateway/types/errors.go`（CSUエラー追加）
* params

  * `apps/gwc/proto/gwc/gateway/v1/params.proto` + `types/params.go`
