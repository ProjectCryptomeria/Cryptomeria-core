# CSU改修まとめ（GWC / FDSC / MDSC）

本資料は、`CSUプロトコル改修チケット.md` と現実装の差異を埋めるために実施した改修内容を、変更目的・変更点・影響範囲の観点でまとめたものです。  
（方針：**FDSC / MDSC は GWC が IBC で送信しているデータ構造に wire 互換で一致させる**）

---

## 1. 背景と課題

### 1.1 主要課題（致命的不整合）
- GWC が IBC で送信する `GatewayPacketData`（Fragment/Manifest）と、
  FDSC/MDSC が受信側で Unmarshal する `DatastorePacketData` / `MetastorePacketData` が **wire 不一致**。
- 結果として、
  - FDSC で fragment 受信が decode 失敗
  - MDSC で manifest 受信が decode 失敗
  - セッション完了（Finalize→Publish）に到達できない
  という動作不全が起き得る状態だった。

### 1.2 改修ゴール
- **IBC packet.proto の wire 互換性を担保**し、GWC→FDSC / GWC→MDSC の受信が成立する状態にする。
- `site_root` 依存を解消し、CSU の `root_proof` / `session_id` を中核に据える。
- チケット残件のうち実装可能なもの（Issue11、Issue6〜8）を順次入れていく。

---

## 2. 実施内容（段階別）

## P0: Proto（wire互換の回復）
### 2.1 FDSC / MDSC packet 定義の wire 統一
**目的**
- 受信側が GWC の送信 bytes をそのまま Unmarshal できるようにする。

**変更**
- `DatastorePacketData` / `MetastorePacketData` の oneof と内部メッセージを、GWC の `GatewayPacketData` に合わせて再定義。
- `FragmentPacket` を **CSU形式（session_id/root_proof/path/index/data）** に統一。
- `ManifestPacket` を **CSU形式（root_proof/fragment_size/owner/session_id）** を含む形に統一。
- `FileMetadata` に `file_root` を追加し、GWC と一致。

**対象ファイル**
- `apps/fdsc/proto/fdsc/datastore/v1/packet.proto`
- `apps/fdsc/proto/fdsc/datastore/v1/fragment.proto`
- `apps/mdsc/proto/mdsc/metastore/v1/packet.proto`
- `apps/mdsc/proto/mdsc/metastore/v1/manifest.proto`

---

## P1: 型定義（運用仕様の固定化）
### 2.2 FDSC: fragment_id の決定ルール導入
**目的**
- GWC 送信に `fragment_id` が無いので、FDSC 側で保存キーとして使う `fragment_id` を確実に生成できるようにする。

**変更**
- `(session_id, path, index)` から決定論的に `fragment_id` を生成する `MakeFragmentID()` を追加。

**対象ファイル**
- `apps/fdsc/x/datastore/types/types.go`

### 2.3 MDSC: IBC Manifest の最低限バリデーション導入
**目的**
- 受信した manifest が最低限の identity / CSU 情報を満たすことをチェックしやすくする。

**変更**
- `ValidateManifestPacketIdentity()` を追加（project/version/root_proof/fragment_size/owner/session_id を確認）。

**対象ファイル**
- `apps/mdsc/x/metastore/types/types.go`

---

## P2: Go実装（受信・保存ロジックの整合）
### 2.4 FDSC: IBC fragment 受信保存の整合
**目的**
- FDSC `OnRecvPacket()` が CSU fragment を受け取り、重複処理を含めて保存できるようにする。

**変更**
- `DatastorePacketData.FragmentPacket` を受信 → `fragment_id` を `MakeFragmentID()` で生成
- `types.Fragment` に CSU メタデータ（root_proof/session_id/path/index）も保存
- 既存データと同一 bytes の再送は ACK success（冪等）
- 既存と data が異なる場合は conflict として error ack

**対象ファイル**
- `apps/fdsc/x/datastore/module/module_ibc.go`

### 2.5 MDSC: IBC manifest 受信保存の整合
**目的**
- MDSC が CSU manifest を受信し、保存できるようにする。

**変更**
- `MetastorePacketData.ManifestPacket` を受信
- identity/CSU フィールド（root_proof/fragment_size/owner/session_id）を保存
- file map を MDSC ストレージ形式（FileInfo/FragmentLocation）へ変換して保存

**対象ファイル**
- `apps/mdsc/x/metastore/module/module_ibc.go`

---

## 3. 機能追加（チケット残件）

## 3.1 Issue1差分：DistributeItem のターゲットチャネル指定
**目的**
- fragment の送信先 FDSC チャネルを item 単位で指定できるようにする。

**変更**
- `DistributeItem.target_fdsc_channel` を追加
- `DistributeBatch` で指定があればそのチャネルへ送信（未指定なら round-robin）

**対象ファイル**
- `apps/gwc/proto/gwc/gateway/v1/types.proto`
- `apps/gwc/x/gateway/keeper/msg_distribute_batch.go`
- `apps/gwc/x/gateway/types/errors.go`（unknown channel エラー追加）

---

## 3.2 Issue11：Params/limits の導入
**目的**
- deadline/fragment_size/fragment数などをチェーンパラメータで制御できるようにする。

**導入した Params**
- `max_fragment_bytes`
- `max_fragments_per_session`
- `default_deadline_seconds`
- `enable_legacy_upload`（将来互換用の予約）
-（後続 Issue6〜8 のため）`local_admin`

**適用箇所**
- `InitSession`：`fragment_size` 上限・deadline デフォルト適用
- `DistributeBatch`：fragment bytes 上限・セッションあたり fragment 数上限

**対象ファイル**
- `apps/gwc/proto/gwc/gateway/v1/params.proto`
- `apps/gwc/x/gateway/types/params.go`
- `apps/gwc/x/gateway/types/errors.go`
- `apps/gwc/x/gateway/keeper/msg_init_session.go`
- `apps/gwc/x/gateway/keeper/msg_distribute_batch.go`

---

## 3.3 Issue6〜8：Authz/Feegrant revoke + session_id 固定強制
### 3.3.1 Issue8: executor = local-admin 固定
**目的**
- CSU プロトコルの前提として、実行者を固定（local-admin）にする。

**変更**
- Params に `local_admin` を追加
- `InitSession` で executor を local-admin に固定（入力の executor が異なる場合は拒否）
- `DistributeBatch / Finalize / Abort` で local-admin を強制

### 3.3.2 Issue8: session_id 固定の Authz（SessionBoundAuthorization）
**目的**
- local-admin が任意の session を操作できないようにし、**指定 session_id に紐づく許可**のみを認める。

**変更**
- `SessionBoundAuthorization`（authz.Authorization 実装）を追加
- GWC handler 側で、owner→local-admin の grant が存在し、session_id が一致していることを確認

### 3.3.3 Issue6/7: Close で authz revoke / feegrant revoke
**目的**
- セッション終了時に権限を回収し、権限が残留しないようにする。

**変更**
- `FinalizeAndCloseSession` / `AbortAndCloseSession` で best-effort revoke
  - authz: Distribute/Finalize/Abort の MsgTypeURL grant を revoke
  - feegrant: owner→local-admin allowance を revoke

**対象ファイル（主）**
- `apps/gwc/proto/gwc/gateway/v1/authorization.proto`（新規）
- `apps/gwc/proto/gwc/gateway/v1/params.proto`（更新）
- `apps/gwc/x/gateway/types/session_bound_authorization.go`（新規）
- `apps/gwc/x/gateway/types/codec.go`
- `apps/gwc/x/gateway/types/types.go`
- `apps/gwc/x/gateway/types/expected_keepers.go`
- `apps/gwc/x/gateway/module/depinject.go`
- `apps/gwc/x/gateway/keeper/keeper.go`
- `apps/gwc/x/gateway/keeper/authz_feegrant.go`（新規）
- `apps/gwc/x/gateway/keeper/msg_init_session.go`
- `apps/gwc/x/gateway/keeper/msg_distribute_batch.go`
- `apps/gwc/x/gateway/keeper/msg_finalize_close.go`
- `apps/gwc/x/gateway/keeper/msg_abort_close.go`

---

## 4. 追加の互換修正（ビルドエラー対応）
### 4.1 SessionBoundAuthorization.String の重複
- pb生成側が `String()` を生成していたため、手書き `String()` を削除。

**対象ファイル**
- `apps/gwc/x/gateway/types/session_bound_authorization.go`

### 4.2 MDSC Manifest の `Creator` 廃止に伴う参照修正
- `types.Manifest` の owner を `Creator` ではなく `Owner` として扱うように修正。
- simulation の参照も `Owner` に置換。

**対象ファイル**
- `apps/mdsc/x/metastore/keeper/msg_server_manifest.go`
- `apps/mdsc/x/metastore/module/simulation.go`
- `apps/mdsc/x/metastore/simulation/manifest.go`

---

## 5. 影響範囲と注意点（運用/移行）
- **Proto の wire 互換の変更**により、既存の IBC 通信・既存チェーンデータがある場合は注意。
  - 既存の FDSC fragment 保存データ構造（site_root/id）から CSU形式に寄せたため、
    既に運用しているチェーンはマイグレーション設計が必要になる可能性がある。
- `fragment_id` の生成規則は、オフチェーン側の Manifest 生成にも影響する。
  - `PacketFragmentMapping.fragment_id` を埋める側も同一規則を使う必要がある。

---

## 6. 今後の残タスク（未実装/要検討）
- Issue12（テスト）：IBC受信、状態遷移、冪等性・conflict、close/revoke のテスト追加
- MDSC の Manifest ストア設計：project/version/session_id をどうキーにするか、更新戦略の確定
- 既存チェーンがある場合のデータ移行方針（store migration / reset）

---

## 付録：改修の要点（1行まとめ）
- **FDSC/MDSC の IBC 受信 proto を GWC の送信構造に完全一致させ、CSU（root_proof/session_id）中心の保存・実行・権限回収（authz/feegrant）まで実装した。**
