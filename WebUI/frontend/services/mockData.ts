
import { ExperimentResult, NodeStatus, UserAccount, SystemAccount, ExperimentScenario, AllocatorStrategy, TransmitterStrategy } from '../types';

// Mock Nodes for Monitoring
export const generateMockNodes = (count: number): NodeStatus[] => {
  const nodes: NodeStatus[] = [
    { id: 'control-chain', type: 'control', status: 'active', height: 12045, txCount: 5, latency: 12 },
    { id: 'meta-chain', type: 'meta', status: 'active', height: 12040, txCount: 12, latency: 15 },
  ];

  for (let i = 0; i < count; i++) {
    nodes.push({
      id: `datachain-${i}`,
      type: 'data',
      status: Math.random() > 0.95 ? 'error' : 'active',
      height: 12000 + Math.floor(Math.random() * 50),
      txCount: Math.floor(Math.random() * 100),
      latency: 10 + Math.floor(Math.random() * 40),
    });
  }
  return nodes;
};

// Mock Users for Economy
export const generateMockUsers = (): UserAccount[] => [
  { id: 'u1', address: 'raid1x9...f3a', balance: 5000, role: 'admin' },
  { id: 'u2', address: 'raid1k2...99z', balance: 120, role: 'client' },
  { id: 'u3', address: 'raid1p4...m2x', balance: 0, role: 'client' },
];

// Mock System Accounts
export const generateSystemAccounts = (dataChainCount: number): SystemAccount[] => {
    const accounts: SystemAccount[] = [
        { id: 'sys-millionaire', name: 'Millionaire (Pool)', address: 'raid1_genesis_pool_inf', balance: 1000000000, type: 'faucet_source' }
    ];
    for(let i=0; i<dataChainCount; i++) {
        accounts.push({
            id: `sys-relayer-${i}`,
            name: `Relayer (Chain-${i})`,
            address: `raid1_relayer_ch${i}_addr`,
            balance: 50, // Low balance initially
            type: 'relayer'
        });
    }
    return accounts;
}

// Mock Scenarios
export const generateMockScenarios = (): ExperimentScenario[] => [
  {
    id: 'sc-1',
    name: 'Basic Latency Check',
    lastModified: new Date().toISOString(),
    config: {
      allocator: AllocatorStrategy.ROUND_ROBIN,
      transmitter: TransmitterStrategy.ONE_BY_ONE,
      targetChains: ['datachain-0'],
      uploadType: 'Virtual',
      projectName: 'latency-check-project',
      virtualConfig: { sizeMB: 100, chunkSizeKB: 64, files: 10 }
    }
  },
  {
    id: 'sc-2',
    name: 'High Load Stress Test',
    lastModified: new Date().toISOString(),
    config: {
      allocator: AllocatorStrategy.AVAILABLE,
      transmitter: TransmitterStrategy.MULTI_BURST,
      targetChains: ['datachain-0', 'datachain-1', 'datachain-2'],
      uploadType: 'Virtual',
      projectName: 'stress-test-project',
      virtualConfig: { sizeMB: 5120, chunkSizeKB: 128, files: 500 }
    }
  }
];

// Mock Library Results
export const generateMockResults = (): ExperimentResult[] => {
  return [
    {
      id: 'exp-001',
      scenarioName: 'Baseline Test 1GB',
      executedAt: new Date(Date.now() - 86400000).toISOString(),
      status: 'SUCCESS',
      allocator: 'Static',
      transmitter: 'OneByOne',
      dataSizeMB: 1024,
      chunkSizeKB: 64,
      totalTxCount: 16384,
      targetChainCount: 3,
      usedChains: ['data-0', 'data-1', 'data-2'],
      uploadTimeMs: 35000,
      downloadTimeMs: 10000,
      throughputBps: 23860929,
    },
    {
      id: 'exp-002',
      scenarioName: 'Stress Test Random',
      executedAt: new Date(Date.now() - 172800000).toISOString(),
      status: 'FAILED',
      allocator: 'Random',
      transmitter: 'MultiBurst',
      dataSizeMB: 512,
      chunkSizeKB: 64,
      totalTxCount: 8192,
      targetChainCount: 5,
      usedChains: ['data-0', 'data-1', 'data-2', 'data-3', 'data-4'],
      uploadTimeMs: 10000,
      downloadTimeMs: 2000,
      throughputBps: 0,
    },
    {
      id: 'exp-003',
      scenarioName: 'Load Balance Check',
      executedAt: new Date(Date.now() - 3600000).toISOString(),
      status: 'SUCCESS',
      allocator: 'Available',
      transmitter: 'MultiBurst',
      dataSizeMB: 1024,
      chunkSizeKB: 128,
      totalTxCount: 8192,
      targetChainCount: 2,
      usedChains: ['data-0', 'data-2'],
      uploadTimeMs: 22000,
      downloadTimeMs: 10000,
      throughputBps: 33554432,
    },
  ];
};
