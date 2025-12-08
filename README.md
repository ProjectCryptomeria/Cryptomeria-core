# 🖥️ Cryptomeria WebUI

**The Dashboard & Operations Console for Project Cryptomeria.**

Cryptomeria WebUI は、分散型ウェブホスティングシステム **Project Cryptomeria** のための統合管理インターフェースです。
Feature-Sliced Design (FSD) に基づく堅牢なアーキテクチャにより、ブロックチェーン・インフラストラクチャの複雑さを抽象化し、直感的な運用・監視・実験環境を提供します。

> **Note**: 本リポジトリのコードベース内では、プロジェクトの旧コードネームである `RaidChain` という名称が一部使用されています。

## 🚀 Key Features

### 1. 📊 Network Monitoring
分散システムの状態をリアルタイムで可視化します。
* **Topology Graph**: ノード間の接続とIBCパケットの流れをSVGアニメーションで表示。
* **Block Feed**: GWC, MDSC, FDSC 全チェーンのブロック生成イベントをタイムライン表示。
* **Mempool Status**: 各ノードのトランザクション滞留状況を監視。

### 2. 🛠️ Deployment & Control
インフラストラクチャのライフサイクルを管理します。
* **Auto Scaling**: ストレージチェーン (FDSC) のノード数をGUIから動的に増減。
* **Environment Reset**: ワンクリックでの環境初期化と再構築。

### 3. 🧪 Experiment Builder
データ転送ロジックの検証シナリオを作成・実行します。
* **Range Configuration**: データサイズやチャンクサイズを範囲指定し、数百パターンのテストケースを一括生成。
* **Cost Estimation**: 実行前に必要なガスコストを自動試算。
* **File Tree Analysis**: アップロードされたディレクトリ構造を解析・可視化。

### 4. 💰 Economy Management
* **Web Wallet**: ユーザーおよびシステムアカウントの管理。
* **Watchdog**: リレーヤー等の残高を監視し、枯渇を防ぐ自動Faucet機能。

## 🛠️ Tech Stack

* **Framework**: React 19, Vite, TypeScript
* **State Management**: Zustand 5
* **Architecture**: Feature-Sliced Design (FSD)
* **Styling**: Tailwind CSS, Lucide React
* **Simulation**: MSW (Mock Service Worker) for Browser-based emulation

## 🏁 Getting Started

現在、本プロジェクトは **MSW (Mock Service Worker)** により、バックエンドなしで完全な動作シミュレーションが可能です。

### Installation

```bash
git clone https://github.com/projectcryptomeria/cryptomeria-webui.git
cd cryptomeria-webui
yarn install
```

### Development Server

```bash
yarn dev
```
ブラウザで `http://localhost:3000` にアクセスしてください。

## 🧩 Architecture (FSD)

本プロジェクトは [Feature-Sliced Design](https://feature-sliced.design/) に基づき構成されています。

* `app/`: グローバル設定、プロバイダー
* `pages/`: ルーティングとページレイアウト
* `widgets/`: 独立したUIブロック (Sidebar, Header)
* `features/`: ビジネス機能 (Experiment generator, Monitoring logic)
* `entities/`: ドメインモデル (Account, Node, Scenario)
* `shared/`: 再利用可能なコンポーネント、Hooks、API定義

## 🔗 Related Repositories

* **[cryptomeria-core](https://github.com/projectcryptomeria/cryptomeria-core)**: Core Infrastructure (Blockchains)
* **[cryptomeria-tscontroller](https://github.com/projectcryptomeria/cryptomeria-tscontroller)**: Legacy Research Toolkit

---
<div align="center">
  <sub>Managed by Project Cryptomeria</sub>
</div>
