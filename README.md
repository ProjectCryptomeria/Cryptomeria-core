# ⛓️ RaidChain (Development Environment)

RaidChainは、Cosmos SDKを用いた分散型オンチェーンストレージシステムのPoC実装です。Webサイトのホスティングをブロックチェーン上で実現すること（On-chain Web）を目指しています。

## 📦 前提条件 (Prerequisites)

以下のツールがインストールされている必要があります。

* **Go** (1.20+)
* **Node.js** (v18+) & **Yarn**
* **Docker** & **Kubernetes Cluster** (Docker Desktop, Minikube, or Kind)
* **Helm**
* **Just** (タスクランナー)
* **Ignite CLI** (Cosmos SDK開発用)

## 🚀 クイックスタート (All-in-One)

Kubernetesクラスタが起動している状態で、以下のコマンドを実行すると、ビルド・Dockerイメージ作成・デプロイ・初期化までを一括で行います。

```bash
# デフォルトで 2つのデータノード(FDSC) を起動します
just all-in-one

# データノード数を変更したい場合（例：4ノード）
just all-in-one 4
````

## 🛠️ 個別の操作コマンド

`justfile` に定義された主要なコマンドです。

### 1\. ビルド & デプロイ関連

| コマンド | 説明 |
| :--- | :--- |
| `just generate-all` | 各チェーンのProtoファイルからGoコードを生成します。 |
| `just build-all` | 全チェーンのバイナリコンパイルとDockerイメージビルドを行います。 |
| `just deploy [N]` | Helmを使ってK8s上にデプロイします（N=FDSCノード数）。 |
| `just undeploy` | デプロイされたリソースを削除します。 |
| `just hot-reload [chain]` | 指定したチェーン(`gwc`, `mdsc`等)を再ビルドし、稼働中のPodへバイナリを注入して再起動します（高速開発用）。 |

### 2\. コントローラー (実験・操作)

TypeScript製のコントローラーを使用して、ファイルのアップロード実験やベンチマークを行います。

```bash
# 依存パッケージのインストール
just ctl-install

# 対話モードで実験を実行 (アップロード・ダウンロード・検証)
just ctl-exp
# -> 実行後、メニューから実験シナリオ(Task)を選択してください

# 簡易アップロードテスト
just upload-test

# 簡易ダウンロードテスト
just download-test
```

### 3\. チェーン監視

```bash
# ブロック生成状況やトランザクションを監視
just ctl-monitor
```

## 📂 ディレクトリ構造

  * `chain/` - Cosmos SDK ブロックチェーン
      * `gwc`: Gateway Chain (Webサーバー機能、Zip解凍、ルーティング)
      * `mdsc`: Metadata Store Chain (ファイル構造管理)
      * `fdsc`: Fragment Data Store Chain (データ断片保存)
  * `ts-controller/` - クライアントサイドロジック、実験ランナー
  * `k8s/` - Helmチャート、Kubernetesマニフェスト
  * `WebUI/` - 管理用Webインターフェース (Backend/Frontend)
  * `docs/` - 要件定義書、設計ドキュメント

## ⚠️ Stage 4 開発中の注意点

現在、**Stage 4 (On-chain Web)** 機能の実装中です。
`chain/gwc` 内には `zip_logic.go` や `http_handler.go` が含まれていますが、`ts-controller` 側はまだ従来の分割アップロード方式（Stage 3）がデフォルトになっています。

最新の「Zipアップロード機能」をテストする場合は、クライアント側の改修または直接 `curl` 等でGWCのエンドポイントを叩く必要があります。