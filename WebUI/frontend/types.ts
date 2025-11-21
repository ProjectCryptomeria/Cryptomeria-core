
// Layer identifiers
export enum AppLayer {
  MONITORING = 'monitoring',
  DEPLOYMENT = 'deployment',
  ECONOMY = 'economy',
  SCENARIO = 'scenario', // Added Scenario Layer
  EXPERIMENT = 'experiment',
  LIBRARY = 'library',
}

// Monitoring Types
export interface NodeStatus {
  id: string;
  type: 'control' | 'meta' | 'data';
  status: 'active' | 'inactive' | 'error';
  height: number;
  txCount: number;
  latency: number;
}

// Deployment Types
export interface BuildStatus {
  isBuilding: boolean;
  logs: string[];
  progress: number;
}

// Economy Types
export interface UserAccount {
  id: string;
  address: string;
  balance: number;
  role: 'admin' | 'client';
}

export interface SystemAccount {
  id: string;
  name: string; // "Millionaire", "Relayer-0"
  address: string;
  balance: number;
  type: 'faucet_source' | 'relayer';
}

// Experiment Types
export enum AllocatorStrategy {
  STATIC = 'Static',
  ROUND_ROBIN = 'RoundRobin',
  RANDOM = 'Random',
  AVAILABLE = 'Available',
}

export enum TransmitterStrategy {
  ONE_BY_ONE = 'OneByOne',
  MULTI_BURST = 'MultiBurst',
}

export interface RealFileConfig {
  fileCount: number;
  totalSizeMB: number;
  structure: string; // ASCII Tree representation
}

export interface ExperimentConfig {
  allocator: AllocatorStrategy;
  transmitter: TransmitterStrategy;
  targetChains: string[];
  uploadType: 'Virtual' | 'Real';
  projectName: string; // Required for both
  virtualConfig?: {
    sizeMB: number;
    chunkSizeKB: number;
    files: number;
  };
  realConfig?: RealFileConfig;
  userId?: string; // Selected User
  shouldFail?: boolean; // For simulation
}

// Scenario Type for Saving/Loading
export interface ExperimentScenario {
  id: string;
  name: string;
  config: ExperimentConfig;
  lastModified: string;
}

// Active Experiment State (Global)
export interface ActiveExperimentState {
    isRunning: boolean;
    progress: number;
    logs: string[];
    statusMessage: string;
    config: ExperimentConfig | null;
    startTime: number | null;
}

// Library Types
export interface ExperimentResult {
  id: string;
  scenarioName: string;
  executedAt: string; // ISO Date
  status: 'SUCCESS' | 'FAILED' | 'ABORTED';
  
  // Scenario Details
  dataSizeMB: number;
  chunkSizeKB: number;
  totalTxCount: number;
  allocator: string;
  transmitter: string;
  targetChainCount: number;
  usedChains: string[]; // "data-0", "data-2"
  
  // Performance Metrics
  uploadTimeMs: number;
  downloadTimeMs: number;
  throughputBps: number;
  
  // Logs snapshot
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
  label: string; // Display name for the badge
}

// Notifications
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