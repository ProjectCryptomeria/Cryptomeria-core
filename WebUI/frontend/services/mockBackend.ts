
import { NodeStatus, UserAccount, SystemAccount, ExperimentResult, ExperimentScenario, MonitoringUpdate, PacketEvent, MempoolInfo } from '../types';
import { generateMockNodes, generateMockUsers, generateSystemAccounts, generateMockResults } from './mockData';

/**
 * Mock Backend Service
 * 
 * ブラウザ内でバックエンドサーバーの挙動を完全にシミュレートします。
 * 状態（DB）を保持し、VirtualSocketを通じてリアルタイムイベントを発火させます。
 */

// --- Virtual Socket Implementation ---
type MessageHandler = (event: { data: string }) => void;

export class VirtualSocket {
  url: string;
  onmessage: MessageHandler | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  private cleanup: (() => void) | null = null;
  private isClosed = false;

  constructor(url: string) {
    this.url = url;
    console.log(`[MockWS] Connecting to ${url}...`);
    
    // Simulate connection delay
    setTimeout(() => {
      if (this.isClosed) {
          console.log(`[MockWS] Connection aborted for ${url} (closed before open)`);
          return;
      }

      if (this.onopen) this.onopen();
      this.cleanup = MockServer.subscribe(url, (data) => {
        if (this.onmessage && !this.isClosed) {
          this.onmessage({ data: JSON.stringify(data) });
        }
      });
    }, 200);
  }

  send(data: string) {
    if (this.isClosed) return;
    console.log(`[MockWS] Sent: ${data}`);
    // If needed, handle client-to-server messages here
  }

  close() {
    this.isClosed = true;
    if (this.cleanup) this.cleanup();
    if (this.onclose) this.onclose();
    console.log(`[MockWS] Closed ${this.url}`);
  }
}

// --- Mock Server Implementation (Singleton) ---
class MockServerInstance {
  // Database State
  private deployedNodeCount = 5;
  private nodes: NodeStatus[] = [];
  private mempool: MempoolInfo[] = [];
  private users: UserAccount[] = [];
  private systemAccounts: SystemAccount[] = [];
  private results: ExperimentResult[] = [];
  
  private intervals: any[] = [];
  private subscribers: { [url: string]: ((data: any) => void)[] } = {};

  constructor() {
    this.init();
    this.startEventLoop();
  }

  private init() {
    this.nodes = generateMockNodes(this.deployedNodeCount);
    this.users = generateMockUsers();
    this.systemAccounts = generateSystemAccounts(this.deployedNodeCount);
    this.results = generateMockResults();
    this.mempool = Array.from({ length: this.deployedNodeCount }, (_, i) => ({ name: `data-${i}`, txs: Math.floor(Math.random() * 50) }));
  }

  // --- Event Loop (Heartbeat) ---
  private startEventLoop() {
    // 1. Monitoring Heartbeat (1s)
    this.intervals.push(setInterval(() => {
      this.updateNodes();
      this.broadcast('/ws/monitoring', {
        nodes: this.nodes,
        mempool: this.mempool,
        deployedCount: this.deployedNodeCount
      } as MonitoringUpdate);
    }, 1000));

    // 2. Packet Generator (Random)
    this.intervals.push(setInterval(() => {
      if (this.deployedNodeCount > 0 && Math.random() > 0.6) {
        const targetIdx = Math.floor(Math.random() * this.deployedNodeCount);
        const packet: PacketEvent = {
          id: `pkt-${Date.now()}`,
          from: 'control-chain',
          to: `datachain-${targetIdx}`,
          type: 'ibc_transfer',
          timestamp: Date.now()
        };
        this.broadcast('/ws/monitoring/packets', packet);
      }
    }, 1500));
  }

  private updateNodes() {
    if (this.nodes.length !== 2 + this.deployedNodeCount) {
      this.nodes = generateMockNodes(this.deployedNodeCount);
      this.mempool = Array.from({ length: this.deployedNodeCount }, (_, i) => ({ name: `data-${i}`, txs: 0 }));
    }

    this.nodes = this.nodes.map(n => ({
      ...n,
      height: n.height + (n.status === 'active' && Math.random() > 0.7 ? 1 : 0),
      txCount: n.txCount + (n.status === 'active' && Math.random() > 0.5 ? Math.floor(Math.random() * 5) : 0),
      latency: Math.max(5, n.latency + Math.floor(Math.random() * 10) - 5)
    }));

    this.mempool = this.mempool.map(m => ({
      ...m,
      txs: Math.max(0, m.txs + (Math.random() > 0.5 ? 5 : -10) + Math.floor(Math.random() * 5))
    }));
  }

  // --- Pub/Sub System ---
  public subscribe(url: string, callback: (data: any) => void) {
    // Handle query params for subscription routing if needed (simple match for now)
    const baseUrl = url.split('?')[0];
    if (!this.subscribers[baseUrl]) this.subscribers[baseUrl] = [];
    this.subscribers[baseUrl].push(callback);

    // Send initial data immediately
    if (baseUrl === '/ws/monitoring') {
      callback({ nodes: this.nodes, mempool: this.mempool, deployedCount: this.deployedNodeCount });
    }

    return () => {
      this.subscribers[baseUrl] = this.subscribers[baseUrl].filter(cb => cb !== callback);
    };
  }

  private broadcast(url: string, data: any) {
    if (this.subscribers[url]) {
      this.subscribers[url].forEach(cb => cb(data));
    }
  }

  // --- API Handlers ---
  
  // Deployment
  async buildImage() {
    return new Promise<{jobId: string}>(resolve => {
      setTimeout(() => {
        const jobId = `build-${Date.now()}`;
        this.startBuildJob(jobId);
        resolve({ jobId });
      }, 500);
    });
  }

  private startBuildJob(jobId: string) {
    const logs = [
      "Building context: 124.5MB transferred.",
      "Step 1/5 : FROM golang:1.22-alpine as builder",
      "Step 2/5 : WORKDIR /app",
      "Step 3/5 : COPY . .",
      "Step 4/5 : RUN go build -o datachain ./cmd/datachain",
      "Successfully built image 'raidchain/node:latest'"
    ];
    let step = 0;
    const interval = setInterval(() => {
      if (step >= logs.length) {
        this.broadcast(`/ws/deployment/logs`, { jobId, type: 'complete' });
        clearInterval(interval);
      } else {
        this.broadcast(`/ws/deployment/logs`, { jobId, type: 'log', message: logs[step] });
        step++;
      }
    }, 800);
  }

  async scaleCluster(count: number) {
    return new Promise(resolve => {
        setTimeout(() => {
             this.deployedNodeCount = count;
             resolve({ success: true });
        }, 500);
    });
  }

  // Economy
  async getUsers() { return { users: [...this.users], system: [...this.systemAccounts] }; }
  
  async createUser() {
    const newUser: UserAccount = {
      id: `u${Date.now()}`,
      address: `raid1${Math.random().toString(36).substring(7)}${Math.random().toString(36).substring(7)}`,
      balance: 0,
      role: 'client',
      name: `Client ${this.users.length}`
    };
    this.users.push(newUser);
    return newUser;
  }

  async deleteUser(id: string) {
      this.users = this.users.filter(u => u.id !== id);
      return true;
  }

  async faucet(targetId: string, amount: number) {
    const millionaire = this.systemAccounts.find(a => a.type === 'faucet_source');
    if (!millionaire || millionaire.balance < amount) throw new Error("Pool Empty");

    let targetName = "";
    
    // Update System Account
    millionaire.balance -= amount;

    // Update Target
    const user = this.users.find(u => u.id === targetId);
    if (user) {
        user.balance += amount;
        targetName = user.address;
    } else {
        const sys = this.systemAccounts.find(s => s.id === targetId);
        if (sys) {
            sys.balance += amount;
            targetName = sys.name;
        }
    }
    return { success: true, targetName };
  }

  // Experiment
  async runExperiment(scenarios: ExperimentScenario[]) {
      const executionId = `exec-${Date.now()}`;
      // Start async simulation
      this.startExperimentSimulation(executionId, scenarios);
      return { executionId };
  }

  private async startExperimentSimulation(executionId: string, scenarios: ExperimentScenario[]) {
      // Simulate sequential execution
      for (const scenario of scenarios) {
          if (scenario.status !== 'READY') continue;
          
          this.broadcast(`/ws/experiment/progress`, { executionId, scenarioId: scenario.id, status: 'RUNNING', log: '[INFO] Initializing transaction batch...' });
          await new Promise(r => setTimeout(r, 800));
          
          this.broadcast(`/ws/experiment/progress`, { executionId, scenarioId: scenario.id, log: '[INFO] Broadcast Tx: 0x3a...f1' });
          await new Promise(r => setTimeout(r, 800));

          const success = Math.random() > 0.15;
          const status = success ? 'COMPLETE' : 'FAIL';
          const log = success ? '[SUCCESS] Data commited to block.' : '[ERROR] Consensus timeout.';
          
          this.broadcast(`/ws/experiment/progress`, { executionId, scenarioId: scenario.id, status, log });
          
          if (success) {
              // Save result
               this.results.unshift({
                  id: `res-${scenario.uniqueId}`,
                  scenarioName: `Auto Execution #${scenario.id}`,
                  executedAt: new Date().toISOString(),
                  status: 'SUCCESS',
                  dataSizeMB: scenario.dataSize,
                  chunkSizeKB: scenario.chunkSize,
                  totalTxCount: Math.floor((scenario.dataSize * 1024) / scenario.chunkSize),
                  allocator: scenario.allocator,
                  transmitter: scenario.transmitter,
                  targetChainCount: scenario.chains,
                  usedChains: scenario.targetChains,
                  uploadTimeMs: 1234,
                  downloadTimeMs: 567,
                  throughputBps: 1000000,
                  logs: scenario.logs
               });
          }
      }
      this.broadcast(`/ws/experiment/progress`, { executionId, type: 'ALL_COMPLETE' });
  }
  
  async getResults() { return this.results; }
  async deleteResult(id: string) { this.results = this.results.filter(r => r.id !== id); return true; }
}

export const MockServer = new MockServerInstance();

// Note: api client has been moved to services/api.ts to use fetch + MSW
