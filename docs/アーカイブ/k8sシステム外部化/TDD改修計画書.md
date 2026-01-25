# 🏗️ Cryptomeria システム外部化・TDD改修計画

## 📅 フェーズ1: インフラの静的化（State Freeze）

まずは「勝手に動かない」「データが消えない」状態を作ります。

### ステップ 1-1: Relayerの待機モード化
* **目的:** リレイヤーが起動しても何もせず、外部からの命令待ち（Sleep）状態になること。
* **テスト要件 (Test Spec):**
    1.  RelayerのPodが `Running` 状態であること。
    2.  Relayerコンテナ内で `rly config show` を実行した際、初期化されていない（エラーになる、または空である）こと。
    3.  既存の自動化スクリプトが走っていないこと（プロセス確認）。
* **テスト手法:**
    * `kubectl get pod -l app=relayer` でStatus確認。
    * `kubectl exec [relayer-pod] -- rly config show` の終了コードが非0であることを確認。

### ステップ 1-2: データの永続化 (PVC)
* **目的:** Podを再起動しても `/home/relayer/.relayer` 内のファイルが維持されること。
* **テスト要件:**
    1.  Relayer Pod内に適当なファイル（例: `touch /home/relayer/.relayer/testfile`）を作成。
    2.  `kubectl delete pod [relayer-pod]` で再起動。
    3.  新しく立ち上がったPod内に `testfile` が存在すること。
* **テスト手法:**
    * シェルスクリプトで `kubectl exec` を使いファイル作成 → `kubectl delete` → `kubectl exec` でファイル存在確認を行う自動テストを作成。

### ステップ 1-3: Genesisアカウントの固定化
* **目的:** どの環境で起動しても、指定した「ミリオネア」と「Local Admin」のアドレスに資金があること。
* **テスト要件:**
    1.  チェーン起動後、ミリオネアの固定アドレスの残高をクエリし、`100,000,000,000uatom` であること。
    2.  Local Adminの固定アドレスの残高をクエリし、設定通りの額（例: `10000uatom`）であること。
* **テスト手法:**
    * `gwcd q bank balances [ミリオネアアドレス]` のJSON出力をパースして検証。

---

## 💻 フェーズ2: コントローラーロジックの実装（Logic Externalization）

インフラが静かになったので、外部から操作するスクリプトを一つずつ実装します。

### ステップ 2-1: `init-relayer-config` (初期設定)
* **目的:** 空のリレイヤーに対し、`rly config init` とチェーン定義ファイルの追加を行う。
* **テスト要件:**
    1.  スクリプト実行前は `~/.relayer/config/config.yaml` が存在しない。
    2.  スクリプト実行後、Configファイルが存在し、GWC/MDSC/FDSCのチェーン定義が含まれていること。
* **テスト手法:**
    * `kubectl exec` でファイル有無と `cat config.yaml` の内容（grepでチェーンID検索）を確認。

### ステップ 2-2: `connect-chain` (接続ロジック) - 前半: 鍵と資金
* **目的:** ターゲットチェーン用の鍵を作成し、ミリオネアから資金を注入する。
* **テスト要件:**
    1.  **冪等性:** 鍵がなければ作成、あれば既存のものを使う。
    2.  **資金供給:** スクリプト実行後、作成された鍵のアドレスに十分な残高（ガス代）があること。
* **テスト手法:**
    * 実行前に鍵がない状態を確認 → 実行 → 鍵生成と残高確認。
    * もう一度実行 → エラーにならず、鍵が変わっていない（アドレスが同じ）ことを確認。

### ステップ 2-3: `connect-chain` (接続ロジック) - 後半: リンクと登録
* **目的:** IBCパス（Gateway, Transfer）を確立し、チャネルIDを登録する。
* **テスト要件:**
    1.  `rly paths list` でパスが確立（チェックマークなど）されていること。
    2.  GWCチェーン上で `gwcd q gateway endpoints` を叩き、ターゲットチェーンのチャネルIDが登録されていること。
* **テスト手法:**
    * スクリプト実行後、`rly paths list` の出力をgrepして確認。
    * `gwcd q gateway endpoints` のJSON出力に対象チェーンIDが含まれているか確認。

---

## 🚀 フェーズ3: 統合オーケストレーション (Integration)

一連の流れを `Justfile` でまとめ、全体動作を保証します。

### ステップ 3-1: End-to-End (E2E) 接続テスト
* **目的:** `just setup -> just connect` の流れで、実際にアプリケーションレベルの通信ができること。
* **テスト要件:**
    1.  FDSC（Datastore）にデータをアップロードする。
    2.  GWC経由でダウンロードできること（既存の `poc-upload-test.sh` 等が通ること）。
* **テスト手法:**
    * 既存の統合テストスクリプト (`ops/scripts/test/poc-upload-test.sh`) を実行し、Exit Code 0 で終了すること。

### ステップ 3-2: 障害復旧テスト (Resilience)
* **目的:** リレイヤーのPodが落ちても、PVCのおかげで設定不要ですぐに復帰できること。
* **テスト要件:**
    1.  接続済みの状態でリレイヤーPodを削除。
    2.  Pod再起動後、設定コマンドを打たなくてもIBC通信（アップロード/ダウンロード）が可能であること。
* **テスト手法:**
    * `kubectl delete pod` → `kubectl wait --for=condition=ready` → `poc-upload-test.sh` 実行。
