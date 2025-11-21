
/**
 * RaidChain WebUI Type Definitions
 * 
 * アプリケーション全体で使用される型定義ファイルです。
 * 各機能レイヤー（監視、デプロイ、経済、実験、ライブラリ）ごとのデータモデルを定義しています。
 */

// --- Layer Identifiers ---
export enum AppLayer {
  MONITORING = 'monitoring', // リアルタイム監視画面
  DEPLOYMENT = 'deployment', // インフラ管理・デプロイ画面
  ECONOMY = 'economy',       // アカウント・トークン管理画面
  PRESET = 'preset',         // 実験プリセット管理画面 (旧 Scenario)
  EXPERIMENT = 'experiment', // 実験設定・実行画面
  LIBRARY = 'library',       // 過去の実験結果アーカイブ画面
}

// --- Monitoring Types (監視レイヤー用) ---
export interface NodeStatus {
  id: string;           // ノードの一意なID (例: datachain-0)
  type: 'control' | 'meta' | 'data'; // ノードの役割
  status: 'active' | 'inactive' | 'error'; // 稼働状態
  height: number;       // 最新ブロック高
  txCount: number;      // 処理済みトランザクション数
  latency: number;      // 応答遅延 (ms)
}

export interface MempoolInfo {
  name: string;
  txs: number;
}

export interface MonitoringUpdate {
  nodes: NodeStatus[];
  mempool: MempoolInfo[];
  deployedCount: number;
}

export interface PacketEvent {
  id: string;
  from: string;
  to: string;
  type: 'ibc_transfer' | 'meta_sync';
  timestamp: number;
}

// --- Deployment Types (デプロイレイヤー用) ---
export interface BuildStatus {
  isBuilding: boolean;
  logs: string[];
  progress: number;
}

// --- Economy Types (経済レイヤー用) ---
export interface UserAccount {
  id: string;
  address: string;      // ウォレットアドレス (raid1...)
  balance: number;      // トークン残高
  role: 'admin' | 'client'; // 権限ロール
  name?: string;        // 表示名
}

export interface SystemAccount {
  id: string;
  name: string;         // アカウント名 (例: "Millionaire", "Relayer-0")
  address: string;
  balance: number;
  type: 'faucet_source' | 'relayer'; // アカウントの種類
}

// --- Experiment Types (実験レイヤー用) ---
export enum AllocatorStrategy {
  STATIC = 'Static',
  ROUND_ROBIN = 'RoundRobin',
  RANDOM = 'Random',
  AVAILABLE = 'Available',
  HASH = 'Hash',
}

export enum TransmitterStrategy {
  ONE_BY_ONE = 'OneByOne',
  MULTI_BURST = 'MultiBurst',
}

export interface RealFileConfig {
  fileCount: number;
  totalSizeMB: number;
  structure: any; // Tree
}

export interface ExperimentConfig {
  allocator: AllocatorStrategy;
  transmitter: TransmitterStrategy;
  targetChains: string[];
  uploadType: 'Virtual' | 'Real';
  projectName: string;
  virtualConfig?: {
    sizeMB: number;
    chunkSizeKB: number;
    files: number;
  };
  realConfig?: RealFileConfig;
  userId?: string;
  shouldFail?: boolean;
}

export type ScenarioStatus = 'PENDING' | 'CALCULATING' | 'READY' | 'RUNNING' | 'COMPLETE' | 'FAIL';

export interface ExperimentScenario {
    id: number;
    uniqueId: string;
    dataSize: number;
    chunkSize: number;
    allocator: AllocatorStrategy;
    transmitter: TransmitterStrategy;
    chains: number;
    targetChains: string[];
    budgetLimit: number;
    cost: number;
    status: ScenarioStatus;
    failReason: string | null;
    progress: number;
    logs: string[];
}

export interface ExperimentPreset {
  id: string;
  name: string;
  config: ExperimentConfig;
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
  lastModified: string;
}

// --- Library Types (ライブラリレイヤー用) ---
export interface ExperimentResult {
  id: string;
  scenarioName: string;
  executedAt: string;
  status: 'SUCCESS' | 'FAILED' | 'ABORTED';
  dataSizeMB: number;
  chunkSizeKB: number;
  totalTxCount: number;
  allocator: string;
  transmitter: string;
  targetChainCount: number;
  usedChains: string[];
  uploadTimeMs: number;
  downloadTimeMs: number;
  throughputBps: number;
  logs?: string[];
}

export type SortDirection = 'asc' | 'desc';
export interface SortConfig {
  key: keyof ExperimentResult;
  direction: SortDirection;
}

export interface FilterCondition {
  key: keyof ExperimentResult;
  value: string;
  label: string;
}

// --- Notifications ---
export interface Toast {
  id: string;
  type: 'success' | 'error';
  title: string;
  message: string;
}

export interface NotificationItem extends Toast {
  timestamp: number;
  read: boolean;
}
