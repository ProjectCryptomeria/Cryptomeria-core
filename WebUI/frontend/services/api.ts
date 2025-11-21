import { ExperimentConfig, ExperimentScenario } from '../types';
import { MockServer } from './mockBackend';

// 擬似的な非同期遅延を作成するヘルパー
const delay = <T>(ms: number, result: T): Promise<T> => 
  new Promise(resolve => setTimeout(() => resolve(result), ms));

export const api = {
  deployment: {
    build: async () => {
      await delay(500, null);
      return MockServer.buildImage();
    },
    scale: async (replicaCount: number) => {
      await delay(500, null);
      // MockServer自体が内部で遅延を持っている場合は二重になりますが、許容範囲です
      await MockServer.scaleCluster(replicaCount);
      return { status: 'accepted' };
    },
    reset: async () => {
      await delay(300, null);
      await MockServer.scaleCluster(0);
      return { success: true };
    }
  },
  economy: {
    getUsers: async () => {
      await delay(200, null);
      return MockServer.getUsers();
    },
    createUser: async () => {
      await delay(300, null);
      return MockServer.createUser();
    },
    deleteUser: async (id: string) => {
      await delay(300, null);
      return MockServer.deleteUser(id);
    },
    faucet: async (targetId: string, amount?: number) => {
      await delay(300, null);
      return MockServer.faucet(targetId, amount || 100);
    },
  },
  experiment: {
    estimate: async (config: ExperimentConfig) => {
      await delay(200, null);
      // 簡易試算ロジック (ハンドラーから移植)
      const sizeMB = config.virtualConfig?.sizeMB || (config.realConfig?.totalSizeMB || 0);
      const chainCount = config.targetChains?.length || 1;
      const cost = sizeMB * 0.5 + chainCount * 10;
      return { cost, isBudgetSufficient: true };
    },
    run: async (scenarios: ExperimentScenario[]) => {
      await delay(200, null);
      return MockServer.runExperiment(scenarios);
    },
  },
  library: {
    getResults: async () => {
      await delay(200, null);
      return MockServer.getResults();
    },
    deleteResult: async (id: string) => {
       await delay(200, null);
       return MockServer.deleteResult(id);
    }
  },
};