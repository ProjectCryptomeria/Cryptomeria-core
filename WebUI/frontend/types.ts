
/**
 * RaidChain WebUI Type Definitions
 * 
 * アプリケーション全体で使用される型定義ファイルです。
 * 各機能レイヤー（監視、デプロイ、経済、実験、ライブラリ）ごとのデータモデルを定義しています。
 */

// --- Layer Identifiers ---
// アプリケーションのメインナビゲーション（画面）を識別するためのEnum
export enum AppLayer {
  MONITORING = 'monitoring', // リアルタイム監視画面
  DEPLOYMENT = 'deployment', // インフラ管理・デプロイ画面
  ECONOMY = 'economy',       // アカウント・トークン管理画面
  PRESET = 'preset',         // 実験プリセット管理画面 (旧 Scenario)
  EXPERIMENT = 'experiment', // 実験設定・実行画面
  LIBRARY = 'library',       // 過去の実験結果アーカイブ画面
}

// --- Monitoring Types (監視レイヤー用) ---
// ノードの状態を表すインターフェース
export interface NodeStatus {
  id: string;           // ノードの一意なID (例: datachain-0)
  type: 'control' | 'meta' | 'data'; // ノードの役割
  status: 'active' | 'inactive' | 'error'; // 稼働状態
  height: number;       // 最新ブロック高
  txCount: number;      // 処理済みトランザクション数
  latency: number;      // 応答遅延 (ms)
}

// --- Deployment Types (デプロイレイヤー用) ---
// Dockerイメージのビルド状態
export interface BuildStatus {
  isBuilding: boolean;  // ビルド実行中かどうか
  logs: string[];       // ビルドログの配列
  progress: number;     // 進捗率 (0-100)
}

// --- Economy Types (経済レイヤー用) ---
// 一般ユーザーのアカウント情報
export interface UserAccount {
  id: string;
  address: string;      // ウォレットアドレス (raid1...)
  balance: number;      // トークン残高
  role: 'admin' | 'client'; // 権限ロール
  name?: string;        // 表示名
}

// システム用アカウント情報（Faucet元やRelayerなど）
export interface SystemAccount {
  id: string;
  name: string;         // アカウント名 (例: "Millionaire", "Relayer-0")
  address: string;
  balance: number;
  type: 'faucet_source' | 'relayer'; // アカウントの種類
}

// --- Experiment Types (実験レイヤー用) ---
// データ配布アルゴリズムの戦略
export enum AllocatorStrategy {
  STATIC = 'Static',          // 静的割り当て
  ROUND_ROBIN = 'RoundRobin', // ラウンドロビン
  RANDOM = 'Random',          // ランダム
  AVAILABLE = 'Available',    // 空き容量ベース
  HASH = 'Hash',              // ハッシュベース
}

// データ送信方法の戦略
export enum TransmitterStrategy {
  ONE_BY_ONE = 'OneByOne',    // 1つずつ順次送信
  MULTI_BURST = 'MultiBurst', // 並列バースト送信
}

// 物理ファイルアップロード時の構成情報
export interface RealFileConfig {
  fileCount: number;
  totalSizeMB: number;
  structure: string; // ASCIIツリー形式の構造表現
}

// 実験設定の共通インターフェース（保存・実行に使用）
export interface ExperimentConfig {
  allocator: AllocatorStrategy;   // 配布戦略
  transmitter: TransmitterStrategy; // 送信戦略
  targetChains: string[];         // 対象チェーンIDのリスト
  uploadType: 'Virtual' | 'Real'; // データソース（仮想生成 or 実ファイル）
  projectName: string;            // プロジェクト名
  
  // 仮想データ生成時の設定
  virtualConfig?: {
    sizeMB: number;      // 総データサイズ
    chunkSizeKB: number; // チャンクサイズ
    files: number;       // ファイル数
  };
  
  realConfig?: RealFileConfig; // 実ファイル使用時の設定
  userId?: string;             // 実行ユーザーID
  shouldFail?: boolean;        // シミュレーション用の失敗フラグ
}

// シナリオ（個別の実験条件）のステータス
// PENDING: 待機中, CALCULATING: コスト試算中, READY: 実行可能
// RUNNING: 実行中, COMPLETE: 成功, FAIL: 失敗
export type ScenarioStatus = 'PENDING' | 'CALCULATING' | 'READY' | 'RUNNING' | 'COMPLETE' | 'FAIL';

// 実験シナリオ
// ExperimentLayerで生成される「1つの実験単位」を表す
export interface ExperimentScenario {
    id: number;             // シーケンスID
    uniqueId: string;       // 一意な識別子 (timestamp等を含む)
    
    // 設定パラメータ
    dataSize: number;       // データサイズ (MB)
    chunkSize: number;      // チャンクサイズ (KB)
    allocator: AllocatorStrategy;
    transmitter: TransmitterStrategy;
    chains: number;         // 対象チェーン数
    targetChains: string[]; // 具体的なチェーンID
    budgetLimit: number;    // ユーザーの予算上限
    
    // 結果・状態
    cost: number;           // 推定/実績コスト
    status: ScenarioStatus; // 現在のステータス
    failReason: string | null; // 失敗時の理由メッセージ
    
    // 実行状態
    progress: number;       // 進捗率
    logs: string[];         // 実行ログ
}

// 実験プリセット
// ユーザーが保存した実験設定のテンプレート
export interface ExperimentPreset {
  id: string;
  name: string;
  config: ExperimentConfig; // 基本設定（互換性維持のため保持）
  
  // UIジェネレータの状態（範囲指定などの詳細設定を復元するため）
  generatorState?: {
      projectName: string;
      accountValue: string;
      dataSize: { mode: 'fixed' | 'range', fixed: number, start: number, end: number, step: number };
      chunkSize: { mode: 'fixed' | 'range', fixed: number, start: number, end: number, step: number };
      allocators: AllocatorStrategy[];
      transmitters: TransmitterStrategy[];
      selectedChains: string[];
      uploadType: 'Virtual' | 'Real';
  };
  lastModified: string; // 最終更新日時
}

// アクティブな実験のグローバル状態（App全体で共有）
export interface ActiveExperimentState {
    isRunning: boolean;
    statusMessage: string;
}

// --- Library Types (ライブラリレイヤー用) ---
// 完了した実験結果レコード
export interface ExperimentResult {
  id: string;
  scenarioName: string;
  executedAt: string; // ISO Date string
  status: 'SUCCESS' | 'FAILED' | 'ABORTED';
  
  // シナリオ詳細スナップショット
  dataSizeMB: number;
  chunkSizeKB: number;
  totalTxCount: number;
  allocator: string;
  transmitter: string;
  targetChainCount: number;
  usedChains: string[]; // "data-0", "data-2"
  
  // パフォーマンス指標
  uploadTimeMs: number;
  downloadTimeMs: number;
  throughputBps: number;
  
  // 実行時のログスナップショット
  logs?: string[];
}

// ソート設定
export type SortDirection = 'asc' | 'desc';
export interface SortConfig {
  key: keyof ExperimentResult;
  direction: SortDirection;
}

// フィルタ条件
export interface FilterCondition {
  key: keyof ExperimentResult;
  value: string;
  label: string; // バッジ表示用ラベル
}

// --- Notifications ---
// トースト通知
export interface Toast {
  id: string;
  type: 'success' | 'error';
  title: string;
  message: string;
}

// 通知センター用アイテム（既読管理付き）
export interface NotificationItem extends Toast {
  timestamp: number;
  read: boolean;
}