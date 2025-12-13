# Cryptomeriaシステム外部化要件

### 1. アカウント・ジェネシス設計（Genesis Design）

* **[決定事項 1-1] ミリオネアアカウント（GWC）の仕様**
    * **鍵の生成方法:** 固定のニーモニックを使用。
    * **初期残高:** `100,000,000,000uatom` (Cosmosなのでstakeではなくuatomを使用。千億あれば当面枯渇しない)
* **[決定事項 1-2] ローカル管理アカウント（MDSC/FDSC）の仕様**
    * **鍵の管理:** 全FDSCで「同一のニーモニック」を使い回す。
    * **初期残高:** リレイヤーが最初の接続を行うのに十分かつ過剰すぎない額として `10000uatom` を設定。
* **[決定事項 1-3] MDSC, FDSCアカウントの命名規則**
    * 各ノードごとに以下の2つのアカウントを持つ。
    * **`local-admin` アカウント:** リレイヤーのガス欠防止へのFaucetと、Validationを行う（親）。
    * **`relayer` アカウント:** IBCのための作業用アカウント（子）。
* **[決定事項 1-4] リレイヤー用アカウントの命名規則**
    * 各チェーンは `relayer` アカウントを持つ。
    * GWCは `rly-mdsc` (MDSC側), `rly-fdsc-n` (FDSC-0側, nは整数) を持つ。
        * **理由:** IBCパス作成を並列で行うため、単一アカウントではシーケンス競合（Collision）が起きるのを防ぐ（マルチウォレット化）。

### 2. デプロイ・境界線の定義（Deployment Boundary）

Helm（静的）と外部スクリプト（動的）の責任分界点です。

* **[決定事項 2-1] Helmが完了とする「状態」の定義**
    * **リレイヤー:** 「何も設定されていない状態で起動（Sleep/Wait待機）」する。設定ファイルや鍵は、起動後に外部スクリプトから注入する。
    * **各チェーン:** Pod起動後、「ブロック生成開始」まで待つ。外部プロセスによるIBC接続指示に迅速に対応するため。
* **[決定事項 2-2] 外部スクリプトの実行環境**
    * スクリプトは「A. 開発者のローカルPC（`kubectl` 経由でPodを操作）」または「Justコマンド」にて実行。
    * **位置づけ:** あくまでシステム本体ではなく、「実行環境構築」のためのツールとする。

### 3. コントローラー/スクリプトの機能仕様（Controller Spec）

外部化されたロジック（シェルスクリプト/Justコマンド）およびバックエンドAPIの具体的仕様です。

* **[決定事項 3-1] 初期セットアップコマンドの粒度と詳細フロー**
    システムを「インフラ維持」と「接続ロジック」に分離するため、以下の3つのコマンドを定義する。

    * **A. `start-chain` コマンド**
        * **役割:** チェーンノードの初期化からブロック生成開始までを担当。
        * **実行:** StatefulSet起動時。
        * **フロー:**
            1.  初期化チェック（データ有無）。
            2.  `init` & 設定ファイル書き換え。
            3.  **Genesis Setup:** ミリオネア（GWC）やLocal Admin（MDSC/FDSC）を `add-genesis-account` で埋め込み、`gentx` でチェーンを開始。
            4.  `start` でRPC受付開始。

    * **B. `start-relayer` コマンド**
        * **役割:** 外部からの命令を待つ状態で常駐。
        * **実行:** Deployment起動時。
        * **フロー:**
            1.  `rly config init` で空の設定を作成。
            2.  `exec rly start` でプロセスを常駐させる（Wait Mode）。
            * *注: 設定ファイル更新時にプロセスをリロードさせる仕組み（Signal送信やPod再起動など）を考慮する。*

    * **C. `connect-chain` コマンド（本丸）**
        * **役割:** GWCと特定のターゲットチェーンとのIBC接続を「冪等」に確立する。
        * **実行:** WebUIや管理者CLIからのトリガー。
        * **引数:** `--target-chain-id`, `--target-rpc`, `--target-api`
        * **フロー（差分登録・冪等性）:**
            1.  **設定追加:** `rly chains list` を確認し、なければ追加。
            2.  **専用ウォレット準備:** パス専用の鍵（`rly-fdsc-n`）を確認・作成。残高がなければGWCミリオネアから送金（Faucet）。
            3.  **パス確立 (2種類):**
                * **アプリ用パス (gateway):** `rly paths show` で状態確認。未接続なら `rly transact link` を実行。
                    * *src-port: gateway, dst-port: datastore/metastore*
                * **【追加】送金用パス (transfer):** 未接続なら `rly transact link` を実行。
                    * *src-port: transfer, dst-port: transfer*
                    * **目的:** GWCミリオネアから各ノードへのIBC送金を可能にするため。
                * *重要:* 必ず **専用鍵 (`--key`)** を使用し、バージョン **`--version "cryptomeria-1"`** を指定する。
            4.  **経路登録:** `gwcd q gateway endpoints` で確認。未登録なら **`rly q channels gwc` の結果からチャネルIDを逆引き特定** し、`gwcd tx gateway register-storage` を実行する。

* **[決定事項 3-2] IBCファウセットの自動化ロジック**
    * **方針:** 「B. 定期的に残高を監視して減っていたら送る」を採用。
    * **実装:** 資金管理ロジックはPoCのコア機能ではないため、GWC内部ではなくクライアントサイド（CLIツールやWebUIの管理画面）で実装し、必要に応じて管理者が「給油ボタン」を押す等の運用とする。

* **[決定事項 3-3] ユーザー向けファウセットのAPI仕様**
    * **WebUI API:**
        * `POST /api/faucet/claim`
        * Body: `{ "address": "cosmos1..." }`
        * Response: `{ "status": "success", "tx_hash": "...", "amount": "..." }`
    * **バックエンド処理:**
        * 固定の「富豪アカウント」を使用し、`gwcd tx bank send` コマンドを裏で実行する。
    * **制限事項:**
        * 開発フェーズ（Level 1）では制限なし（またはブラウザCookie制限程度）。
        * 将来的にIP制限やreCAPTCHAを導入。

* **[決定事項 3-4] モニタリングAPIと管理機能（新規追加）**
    WebUIや管理者がシステム全体の状態を把握するための参照系機能。
    * **目的:**
        * 全てのシステムアカウント（ミリオネア、Local Admin、Relayer）の残高監視。
        * IBC接続状況（Alive/Dead）の可視化。
        * Faucet可否判定（接続断や残高不足時のボタン非活性化など）。
    * **WebUI API:**
        * **システム状態取得:** `GET /api/admin/status`
            * Response:
                * `accounts`: 各チェーンの重要アカウントのアドレスと残高リスト。
                * `ibc_connections`: 各チェーンとの接続状態（Connected/Disconnected）、チャネルID、最終更新日時など。
    * **バックエンド処理:**
        * 定期的に各チェーンのRPC（`/cosmos/bank/...`）やGWCのクエリ（`gwcd q gateway endpoints`）、リレイヤーの状態（`rly paths list`）をポーリングして情報を集約する。

### 4. リレイヤー設定の永続化（Persistence）

* **[決定事項 4-1] リレイヤー設定の保存先**
    * 外部スクリプトによって追加されたリレイヤーの鍵やパス設定（`~/.relayer`）は、**PVC（Persistent Volume Claim）** に保存する。
    * **理由:** Podが再起動しても、生成した多数の専用鍵や接続情報を維持するため。