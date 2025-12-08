# 🏗️ Cryptomeria Core

**The Kernel of the Modular Inter-chain Web Hosting Ecosystem.**

Cryptomeria Coreは、Project Cryptomeriaの中核となるモノレポ（Monorepo）リポジトリです。
分散型Webホスティングを実現するための3種類のカスタムブロックチェーンの実装、Kubernetesインフラストラクチャ定義、および統合管理インターフェースを管理しています。

## 🧩 アーキテクチャ

本システムは、役割の異なる複数のブロックチェーンがIBC (Inter-Blockchain Communication) で連携し、データの保存と配信を行うモジュラーアーキテクチャを採用しています。

```mermaid
graph TD
    User["User / Browser"] <-->|"HTTP / Transactions"| GWC

    subgraph "Cryptomeria Core Cluster"
        direction TB
        GWC["🛡️ Gateway Chain (GWC)"]
        MDSC["📖 Manifest Data Store (MDSC)"]
        FDSC["💾 Fragment Data Store (FDSC)"]
        
        %% Write Flow
        GWC -- "IBC: Store Fragments" --> FDSC
        GWC -- "IBC: Store Manifest" --> MDSC

        %% Read Flow (Logical)
        MDSC -.->|"HTTP: Fetch Manifest"| GWC
        FDSC -.->|"HTTP: Fetch Fragment"| GWC
    end
```

### コアコンポーネント (`apps/`)

| Component | Role | Description |
| :--- | :--- | :--- |
| **GWC** (Gateway Chain) | **Access Point** | ユーザーからのリクエスト受付、Zip解凍、データ分割（フラグメンテーション）、および各チェーンへの分散処理を行う揮発性チェーン。Webサーバーおよびゲートウェイとして機能します。 |
| **FDSC** (Fragment Data Store) | **Storage** | 分割されたバイナリデータ（Fragment）を実際に保存するストレージチェーン。水平スケーリングによる容量拡張を担います。 |
| **MDSC** (Manifest Data Store) | **Index** | 「どのファイルが、どのFDSCの、どこに保存されているか」というマッピング情報（Manifest Data）を管理するインデックスチェーン。 |

## 🔄 データフロー詳細

### ⬆️ アップロードフロー (Write)
クライアントからアップロードされたデータは、以下の順序で処理され、永続化されます。

1.  **Ingest (受信)**: GWCがクライアントからトランザクションとしてデータを受け取ります（ファイル単体、ディレクトリ、またはZIPファイル）。
2.  **Unzip & Analyze (解凍・解析)**: ZIPファイルを受け取った場合、GWCはメモリ上で展開（Unzip）し、ディレクトリ構造を解析します。
3.  **Fragmentation & Distribution (分割・分散)**: GWCはファイルを「フラグメント（断片）」に分割し、複数の **FDSC (Fragment Data Store Chain)** へIBCパケットを通じて分散保存します。
4.  **Manifest Indexing (インデックス化)**: 「どのFDSCに、どのファイルの、どのフラグメントを保存したか」という構造情報をまとめた **Manifest Data** を生成し、**MDSC (Manifest Data Store Chain)** へIBCパケットで送信・保存します。

### ⬇️ ダウンロードフロー (Read)
Webブラウザ等からのアクセス時は、逆の手順でデータが復元されます。

1.  **Resolve (解決)**: GWCがリクエストされたパスに基づき、**MDSC** から Manifest Data を **HTTPリクエスト** で取得します。
2.  **Fetch (取得)**: Manifestに含まれる場所情報に基づき、GWCが各 **FDSC** から必要なフラグメントを **HTTPリクエスト** で並列取得します。
3.  **Reconstruct (復元)**: GWCがフラグメントを結合して元のファイルを復元し、HTTPレスポンスとしてユーザーに返却します。

## 🔌 統合モジュール
本リポジトリは以下のコンポーネントをGit Submoduleとして統合しています。

* **[apps/webui](https://github.com/projectcryptomeria/cryptomeria-webui)**: システム全体の運用・監視・実験を行うための管理コンソール。
* **[apps/ts-controller](https://github.com/projectcryptomeria/cryptomeria-tscontroller)**: (Legacy) アップロード戦略のプロトタイピング用CLIツール。

## 🛠️ インフラストラクチャ (`ops/`)

Kubernetes上へのデプロイと運用を自動化するためのコード資産が含まれています。

* **Helm Charts**: `ops/infra/k8s/helm` - 全チェーンとRelayerの一括デプロイ定義。
* **CDK8s**: `ops/infra/cdk8s` - TypeScriptによるインフラ構成管理。
* **Scripts**: `ops/scripts` - チェーンのScaffold、E2Eテスト、ベンチマーク用スクリプト。

## 🚀 開発の始め方

### 前提条件
開発には以下のツールが必要です（DevContainerの使用を推奨）。
* Go 1.22+
* Ignite CLI
* Node.js & Yarn
* Docker & Kubernetes (Minikube/Kind)
* **[Just](https://github.com/casey/just)** (Task Runner)

### セットアップとビルド

本リポジトリはサブモジュールを含むため、再帰的にクローンしてください。

```bash
# Clone repository
git clone --recursive [https://github.com/projectcryptomeria/cryptomeria-core.git](https://github.com/projectcryptomeria/cryptomeria-core.git)
cd cryptomeria-core

# Check available commands
just --list
```

### 主なコマンド (via Justfile)

本プロジェクトではタスクランナー `just` を使用して、開発・デプロイ・テストの全工程を効率化しています。

#### 🔄 Workflow (一括操作)
| Command | Description |
| :--- | :--- |
| `just all-in-one [chains=N]` | **完全リセット＆セットアップ**: 既存環境の削除、全バイナリ/Dockerビルド、Kubernetesデプロイを一気通貫で実行します。`chains`でFDSCのノード数を指定可能（デフォルト: 2）。 |

#### 🏗️ Build & Generate (ビルド)
| Command | Description |
| :--- | :--- |
| `just generate-all` | 全チェーン（FDSC, MDSC, GWC）のProtobufコード生成（`ignite generate proto-go`）を一括実行します。 |
| `just build-all` | 全コンポーネント（チェーン3種 + Relayer）のバイナリとDockerイメージを並列ビルドします。 |
| `just build <target>` | 指定したターゲット（`fdsc`, `mdsc`, `gwc`, `relayer`）のみのバイナリとDockerイメージをビルドします。 |

#### ☁️ Operations (インフラ・デプロイ)
| Command | Description |
| :--- | :--- |
| `just deploy [chains=N]` | Helmを使用してクラスタへデプロイします。FDSCのレプリカ数を指定可能です。 |
| `just deploy-clean [chains=N]` | Namespace（永続ボリューム含む）を維持したまま、リソースを再デプロイして状態をリセットします。高速な反復開発向け。 |
| `just upgrade <target>` | 指定したコンポーネントのHelmリリースを更新し、Podをローリング再起動します（データは維持されます）。 |
| `just undeploy` | アプリケーションとPVC（データ）を削除します。 |
| `just clean-k8s` | NamespaceごとKubernetesリソースを完全に削除します（完全初期化用）。 |

#### ⚡ Development (高速開発)
| Command | Description |
| :--- | :--- |
| `just hot-reload <target>` | **ホットリロード**: ローカルでビルドしたバイナリを実行中のPodに直接転送し、プロセスを再起動します（Dockerビルド不要で高速）。 |
| `just scaffold <target>` | 新しいチェーンのひな形（Scaffold）を生成します。 |

#### 🎮 Controller (実験・操作)
| Command | Description |
| :--- | :--- |
| `just ctl-install` | コントローラー（TScontroller）の依存関係をインストールします。 |
| `just ctl-exp` | TScontrollerを対話モードで起動し、アップロード実験シナリオを実行します。 |
| `just ctl-monitor` | 指定チェーンのブロック生成やMempoolをリアルタイム監視します。 |

#### 🧪 Testing (テスト)
| Command | Description |
| :--- | :--- |
| `just upload-test` | `poc-upload-test.sh` を実行し、システムへのデータアップロードを検証します。 |
| `just download-test` | `poc-download-test.sh` を実行し、データのダウンロードと復元を検証します。 |

## 📂 ディレクトリ構造

```
cryptomeria-core/
├── apps/               # アプリケーションコード
│   ├── gwc/            # Gateway Chain (Ignite App)
│   ├── mdsc/           # Manifest Data Store Chain (Ignite App)
│   ├── fdsc/           # Fragment Data Store Chain (Ignite App)
│   ├── webui/          # WebUI (Submodule)
│   └── ts-controller/  # Legacy Controller (Submodule)
├── ops/                # 運用・インフラコード
│   ├── infra/          # Helm Charts, CDK8s
│   └── scripts/        # テスト、Scaffold用スクリプト
├── docs/               # 設計資料、仕様書
└── justfile            # タスクランナー定義
```

## 🔗 関連リポジトリ

* **[Cryptomeria WebUI](https://github.com/projectcryptomeria/cryptomeria-webui)**
* **[Cryptomeria TScontroller](https://github.com/projectcryptomeria/cryptomeria-tscontroller)**

---
<div align="center">
  <sub>Managed by Project Cryptomeria</sub>
</div>
<div align="center">
  <sub>Managed by Project Cryptomeria</sub>
</div>
