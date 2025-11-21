
import React, { useState, useRef, useEffect } from 'react';
import { AppLayer, UserAccount, SystemAccount, ExperimentResult, ActiveExperimentState, ExperimentConfig, ExperimentScenario, Toast, NotificationItem } from './types';
import { NAV_ITEMS } from './constants';
import { generateMockUsers, generateMockResults, generateMockScenarios, generateSystemAccounts } from './services/mockData';
import MonitoringLayer from './layers/MonitoringLayer';
import DeploymentLayer from './layers/DeploymentLayer';
import EconomyLayer from './layers/EconomyLayer';
import ExperimentLayer from './layers/ExperimentLayer';
import LibraryLayer from './layers/LibraryLayer';
import ScenarioLayer from './layers/ScenarioLayer';
import { LayoutDashboard, Bell, CheckCircle, AlertTriangle, X, Trash2, Info } from 'lucide-react';

const App: React.FC = () => {
  const [activeLayer, setActiveLayer] = useState<AppLayer>(AppLayer.MONITORING);

  // --- Global State: Infrastructure ---
  const [deployedNodeCount, setDeployedNodeCount] = useState<number>(5);
  const [isDockerBuilt, setIsDockerBuilt] = useState<boolean>(false);

  // --- Global State: Economy ---
  const [users, setUsers] = useState<UserAccount[]>(generateMockUsers());
  const [systemAccounts, setSystemAccounts] = useState<SystemAccount[]>(generateSystemAccounts(5));

  // Sync System Accounts (Relayers) with Deployed Nodes
  useEffect(() => {
      setSystemAccounts(prev => {
          const millionaire = prev.find(a => a.type === 'faucet_source');
          // Re-generate relayers based on current count
          const newAccounts = generateSystemAccounts(deployedNodeCount);
          if (millionaire) {
              // Preserve millionaire balance
              newAccounts[0].balance = millionaire.balance;
          }
          return newAccounts;
      });
  }, [deployedNodeCount]);

  // --- Global State: Library ---
  const [results, setResults] = useState<ExperimentResult[]>(generateMockResults());

  // --- Global State: Scenarios ---
  const [scenarios, setScenarios] = useState<ExperimentScenario[]>(generateMockScenarios());

  // --- Global State: Active Experiment ---
  const [experimentState, setExperimentState] = useState<ActiveExperimentState>({
    isRunning: false,
    progress: 0,
    logs: [],
    statusMessage: "",
    config: null,
    startTime: null,
  });

  // Experiment Logic Ref (to hold interval ID)
  const experimentInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- Global State: Notifications & Toasts ---
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  const notificationRef = useRef<HTMLDivElement>(null);

  // Close notification dropdown when clicking outside
  useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
          if (notificationRef.current && !notificationRef.current.contains(event.target as Node)) {
              setIsNotificationOpen(false);
          }
      };
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const addToast = (type: 'success' | 'error', title: string, message: string) => {
    const id = Math.random().toString(36).substr(2, 9);
    const newNotification: NotificationItem = {
        id, 
        type, 
        title, 
        message, 
        timestamp: Date.now(),
        read: false 
    };

    // 1. Add to Notification History
    setNotifications(prev => [newNotification, ...prev]);

    // 2. Add to Active Toasts (Limit to 3)
    setToasts(prev => {
        const updated = [...prev, { id, type, title, message }];
        if (updated.length > 3) {
            // Keep only the last 3 elements
            return updated.slice(updated.length - 3);
        }
        return updated;
    });

    // Auto-remove from screen after 5 seconds
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  };

  const clearNotifications = () => {
      setNotifications([]);
  };

  // --- Handlers ---
  
  const handleCreateUser = () => {
    const newUser: UserAccount = {
      id: `u${Date.now()}`,
      address: `raid1${Math.random().toString(36).substring(7)}${Math.random().toString(36).substring(7)}${Math.random().toString(36).substring(7)}`,
      balance: 0,
      role: 'client'
    };
    setUsers([...users, newUser]);
  };

  const handleFaucet = (targetId: string) => {
    const amount = 1000;
    const millionaire = systemAccounts.find(a => a.type === 'faucet_source');
    
    if (!millionaire) return;
    if (millionaire.balance < amount) {
        addToast('error', 'Faucetエラー', 'Millionaireアカウントの資金が枯渇しています。');
        return;
    }

    // Check if target is User
    const userTarget = users.find(u => u.id === targetId);
    if (userTarget) {
        setUsers(users.map(u => u.id === targetId ? { ...u, balance: u.balance + amount } : u));
        setSystemAccounts(prev => prev.map(a => a.id === millionaire.id ? { ...a, balance: a.balance - amount } : a));
        addToast('success', '送金成功', `${userTarget.address.substring(0,8)}... へ 1,000 TKN を送金しました。`);
        return;
    }

    // Check if target is System Account (Relayer)
    const sysTarget = systemAccounts.find(a => a.id === targetId);
    if (sysTarget) {
        setSystemAccounts(prev => prev.map(a => {
            if (a.id === millionaire.id) return { ...a, balance: a.balance - amount };
            if (a.id === targetId) return { ...a, balance: a.balance + amount };
            return a;
        }));
        addToast('success', '補充成功', `${sysTarget.name} へ 1,000 TKN を補充しました。`);
    }
  };

  const handleDeleteUser = (id: string) => {
    setUsers(users.filter(u => u.id !== id));
  };

  const handleSaveScenario = (name: string, config: ExperimentConfig) => {
      const existingIndex = scenarios.findIndex(s => s.name === name);
      const newScenario: ExperimentScenario = {
          id: existingIndex >= 0 ? scenarios[existingIndex].id : crypto.randomUUID(),
          name,
          config,
          lastModified: new Date().toISOString()
      };

      if (existingIndex >= 0) {
          const next = [...scenarios];
          next[existingIndex] = newScenario;
          setScenarios(next);
          addToast('success', '保存完了', `シナリオ "${name}" を更新しました。`);
      } else {
          setScenarios([...scenarios, newScenario]);
          addToast('success', '保存完了', `新しいシナリオ "${name}" を保存しました。`);
      }
  };

  const handleDeleteScenario = (id: string) => {
      setScenarios(scenarios.filter(s => s.id !== id));
      addToast('success', '削除完了', 'シナリオを削除しました。');
  };

  const handleDeleteResult = (id: string) => {
      setResults(results.filter(r => r.id !== id));
      addToast('success', '削除完了', '実験結果データを削除しました。');
  };

  // --- Experiment Logic ---
  const startExperiment = (config: ExperimentConfig, scenarioName: string, estimatedCost: number) => {
    if (experimentState.isRunning) return;

    // 1. Deduct Cost
    const userId = config.userId;
    if (!userId) return;
    
    setUsers(prev => prev.map(u => {
        if (u.id === userId) {
            return { ...u, balance: u.balance - estimatedCost };
        }
        return u;
    }));

    addToast('success', 'デポジット完了', `アカウントから ${estimatedCost.toLocaleString()} TKN を引き落としました。`);

    // 2. Reset state for new run
    setExperimentState({
      isRunning: true,
      progress: 0,
      logs: [`[System] Initializing experiment: ${scenarioName}...`],
      statusMessage: "Initializing...",
      config: config,
      startTime: Date.now(),
    });

    let p = 0;
    const startTime = Date.now();
    const shouldFail = config.shouldFail || false;
    const failAt = 65; // Fail at 65% if scheduled

    // Determine actual chunkSize for logging
    const chunkSizeKB = config.uploadType === 'Real' && config.realConfig 
      ? Math.floor((config.realConfig.totalSizeMB * 1024) / 10) || 64 // Mock logic for real files
      : config.virtualConfig?.chunkSizeKB || 64;

    experimentInterval.current = setInterval(() => {
      p += 1;
      
      // Log generation based on progress
      const newLogs: string[] = [];
      const time = new Date().toLocaleTimeString('ja-JP');
      
      if (p === 5) newLogs.push(`[${time}] Splitting data into ${chunkSizeKB}KB chunks...`);
      if (p === 20) newLogs.push(`[${time}] Generating transactions... Strategy: ${config.allocator}`);
      if (p === 40) newLogs.push(`[${time}] Broadcasting to ${config.targetChains.length} chains...`);
      
      // Error Simulation
      if (shouldFail && p === failAt) {
        clearInterval(experimentInterval.current!);
        const failLogs = [...newLogs, `[${time}] [ERROR] Transaction broadcast timeout on data-2.`, `[${time}] [FATAL] Experiment aborted due to network error.`];
        
        setExperimentState(prev => ({
          ...prev,
          isRunning: false,
          progress: p,
          logs: [...prev.logs, ...failLogs],
          statusMessage: "エラー: 実験が中断されました",
        }));

        // Fail Cost Logic
        const actualCost = Math.floor(estimatedCost * 0.8); // Consumed 80% before fail
        const refund = estimatedCost - actualCost;
        
        if (refund > 0) {
             setUsers(prev => prev.map(u => u.id === userId ? { ...u, balance: u.balance + refund } : u));
        }

        addToast('error', '実験失敗', `エラーにより中断。コスト: ${actualCost} TKN (返金: ${refund} TKN)`);
        
        // Save Failed Result
        saveResult(scenarioName, 'FAILED', config, startTime, Date.now());
        return;
      }

      if (p === 90) newLogs.push(`[${time}] Verifying manifest on MetaChain...`);
      if (p === 100) {
        clearInterval(experimentInterval.current!);
        const successLogs = [...newLogs, `[${time}] Experiment Completed Successfully.`];
        
        setExperimentState(prev => ({
          ...prev,
          isRunning: false,
          progress: 100,
          logs: [...prev.logs, ...successLogs],
          statusMessage: "完了",
        }));

        addToast('success', '実験完了', 'すべてのデータが正常に処理されました。');
        saveResult(scenarioName, 'SUCCESS', config, startTime, Date.now());
        return;
      }

      setExperimentState(prev => ({
        ...prev,
        progress: p,
        logs: newLogs.length > 0 ? [...prev.logs, ...newLogs] : prev.logs,
        statusMessage: p < 30 ? "Data Sharding..." : p < 80 ? "Broadcasting..." : "Verifying...",
      }));

    }, 50); // Simulation Speed
  };

  const saveResult = (scenarioName: string, status: 'SUCCESS' | 'FAILED' | 'ABORTED', config: ExperimentConfig, startTime: number, endTime: number) => {
    const durationMs = endTime - startTime;
    
    // Correctly calculate data size based on upload type
    const dataSizeMB = config.uploadType === 'Virtual'
        ? (config.virtualConfig?.sizeMB || 0)
        : (config.realConfig?.totalSizeMB || 0);

    const chunkSizeKB = config.uploadType === 'Virtual'
        ? (config.virtualConfig?.chunkSizeKB || 0)
        : (config.realConfig ? Math.round((config.realConfig.totalSizeMB * 1024) / 100) : 64); // Rough estimate for real

    // Mock calculations for metrics
    const uploadTimeMs = Math.floor(durationMs * 0.7);
    const downloadTimeMs = Math.floor(durationMs * 0.3);
    
    // Calculate Throughput (bps) = (SizeMB * 1024 * 1024 * 8) / (TimeSeconds)
    // Use upload time for upload throughput. Avoid division by zero.
    const throughputBps = (uploadTimeMs > 0 && dataSizeMB > 0)
        ? Math.floor((dataSizeMB * 1024 * 1024 * 8) / (uploadTimeMs / 1000)) 
        : 0;

    const result: ExperimentResult = {
      id: `exp-${Date.now()}`,
      scenarioName,
      executedAt: new Date().toISOString(),
      status,
      dataSizeMB,
      chunkSizeKB,
      totalTxCount: Math.floor(dataSizeMB * 1024 / (chunkSizeKB || 64)) || 0,
      allocator: config.allocator,
      transmitter: config.transmitter,
      targetChainCount: config.targetChains.length,
      usedChains: config.targetChains,
      uploadTimeMs,
      downloadTimeMs,
      throughputBps,
      logs: experimentState.logs // Snapshot
    };

    setResults(prev => [result, ...prev]);
  };

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-slate-50 text-slate-900 font-sans selection:bg-blue-100 selection:text-blue-900">
      
      {/* --- Header --- */}
      <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between z-40 shadow-sm shrink-0">
        <div className="flex items-center gap-3">
           <div className="bg-blue-600 p-1.5 rounded-lg">
             <LayoutDashboard className="text-white w-5 h-5" />
           </div>
           <div>
               <h1 className="font-bold text-lg tracking-tight text-slate-900 leading-none">RaidChain <span className="text-slate-400 font-light">WebUI</span></h1>
               <div className="text-[10px] text-slate-500 font-mono leading-none mt-1">v2.4.0-rc1 • Cluster: minikube</div>
           </div>
        </div>

        <div className="flex items-center gap-4">
             {/* System Status Indicator */}
             <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-slate-50 rounded-full border border-slate-200">
                 <div className={`w-2 h-2 rounded-full ${deployedNodeCount > 0 ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}></div>
                 <span className="text-xs font-medium text-slate-600">
                     {deployedNodeCount > 0 ? 'System Online' : 'System Offline'}
                 </span>
             </div>

             {/* Notifications */}
             <div className="relative" ref={notificationRef}>
                 <button 
                    className="relative p-2 text-slate-400 hover:text-slate-600 transition-colors hover:bg-slate-100 rounded-full"
                    onClick={() => setIsNotificationOpen(!isNotificationOpen)}
                 >
                     <Bell className="w-5 h-5" />
                     {notifications.filter(n => !n.read).length > 0 && (
                         <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full ring-2 ring-white"></span>
                     )}
                 </button>

                 {isNotificationOpen && (
                     <div className="absolute right-0 mt-2 w-80 bg-white rounded-xl shadow-xl border border-slate-100 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                         <div className="px-4 py-3 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                             <h3 className="text-sm font-bold text-slate-700">Notifications</h3>
                             <button onClick={clearNotifications} className="text-xs text-blue-600 hover:underline">Clear all</button>
                         </div>
                         <div className="max-h-80 overflow-y-auto">
                             {notifications.length === 0 ? (
                                 <div className="p-8 text-center text-slate-400 text-sm">No notifications</div>
                             ) : (
                                 notifications.map(n => (
                                     <div key={n.id} className="px-4 py-3 border-b border-slate-50 hover:bg-slate-50 transition-colors">
                                         <div className="flex gap-3">
                                             <div className={`mt-1 ${n.type === 'success' ? 'text-emerald-500' : 'text-red-500'}`}>
                                                 {n.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                                             </div>
                                             <div>
                                                 <div className="text-sm font-medium text-slate-800">{n.title}</div>
                                                 <div className="text-xs text-slate-500 mt-0.5 leading-relaxed">{n.message}</div>
                                                 <div className="text-[10px] text-slate-400 mt-1 text-right">
                                                     {new Date(n.timestamp).toLocaleTimeString()}
                                                 </div>
                                             </div>
                                         </div>
                                     </div>
                                 ))
                             )}
                         </div>
                     </div>
                 )}
             </div>
        </div>
      </header>

      {/* --- Navigation & Main Content --- */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Sidebar Nav */}
        <nav className="w-64 bg-white border-r border-slate-200 flex flex-col py-6 gap-1 z-30 shadow-[4px_0_24px_-12px_rgba(0,0,0,0.1)] shrink-0 overflow-y-auto">
            <div className="px-6 mb-2 text-xs font-bold text-slate-400 uppercase tracking-wider">Main Menu</div>
            {NAV_ITEMS.map(item => {
                const isActive = activeLayer === item.id;
                return (
                    <button
                        key={item.id}
                        onClick={() => setActiveLayer(item.id)}
                        className={`relative mx-3 px-4 py-3 rounded-xl text-left transition-all duration-200 flex items-center gap-3 group ${
                            isActive 
                            ? 'bg-blue-50 text-blue-700 shadow-sm' 
                            : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                        }`}
                    >
                        {isActive && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-blue-500 rounded-r-full"></div>}
                        <item.icon className={`w-5 h-5 ${isActive ? 'text-blue-600' : 'text-slate-400 group-hover:text-slate-600'}`} />
                        <div>
                            <div className={`font-bold text-sm ${isActive ? 'text-blue-800' : 'text-slate-700'}`}>{item.label}</div>
                            <div className="text-[10px] text-slate-400 font-medium">{item.subLabel}</div>
                        </div>
                    </button>
                );
            })}
            
            <div className="mt-auto px-6 pt-6 border-t border-slate-100">
                <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                    <div className="flex items-center gap-2 mb-2">
                        <Info className="w-4 h-4 text-blue-500" />
                        <span className="text-xs font-bold text-slate-700">Cluster Info</span>
                    </div>
                    <div className="space-y-1">
                        <div className="flex justify-between text-[10px]">
                            <span className="text-slate-500">Provider</span>
                            <span className="font-mono text-slate-700">Minikube</span>
                        </div>
                        <div className="flex justify-between text-[10px]">
                            <span className="text-slate-500">K8s Ver</span>
                            <span className="font-mono text-slate-700">v1.28.3</span>
                        </div>
                        <div className="flex justify-between text-[10px]">
                            <span className="text-slate-500">Memory</span>
                            <span className="font-mono text-slate-700">8192MB</span>
                        </div>
                    </div>
                </div>
            </div>
        </nav>

        {/* Main Viewport */}
        <main className="flex-1 bg-slate-50/50 relative overflow-hidden">
            
            {/* Layer Container */}
            <div className="h-full w-full p-6 overflow-y-auto custom-scrollbar">
                {activeLayer === AppLayer.MONITORING && <MonitoringLayer deployedNodeCount={deployedNodeCount} />}
                
                {activeLayer === AppLayer.DEPLOYMENT && (
                    <DeploymentLayer 
                        setDeployedNodeCount={setDeployedNodeCount} 
                        deployedNodeCount={deployedNodeCount}
                        setIsDockerBuilt={setIsDockerBuilt}
                        isDockerBuilt={isDockerBuilt}
                    />
                )}
                
                {activeLayer === AppLayer.ECONOMY && (
                    <EconomyLayer 
                        users={users} 
                        systemAccounts={systemAccounts} 
                        onCreateUser={handleCreateUser} 
                        onDeleteUser={handleDeleteUser}
                        onFaucet={handleFaucet}
                    />
                )}

                {activeLayer === AppLayer.SCENARIO && (
                    <ScenarioLayer 
                        scenarios={scenarios}
                        onDeleteScenario={handleDeleteScenario}
                    />
                )}
                
                {activeLayer === AppLayer.EXPERIMENT && (
                    <ExperimentLayer 
                        activeExperiment={experimentState}
                        users={users}
                        scenarios={scenarios}
                        deployedNodeCount={deployedNodeCount}
                        onRunExperiment={startExperiment}
                        onSaveScenario={handleSaveScenario}
                        notify={addToast}
                    />
                )}
                
                {activeLayer === AppLayer.LIBRARY && <LibraryLayer results={results} onDeleteResult={handleDeleteResult} />}
            </div>

            {/* Toast Overlay */}
            <div className="absolute bottom-6 right-6 z-50 flex flex-col gap-3 pointer-events-none">
                {toasts.map(toast => (
                    <div key={toast.id} className="bg-white rounded-lg shadow-lg border border-slate-200 p-4 w-80 animate-in slide-in-from-right-10 fade-in duration-300 pointer-events-auto flex items-start gap-3">
                        <div className={`mt-0.5 ${toast.type === 'success' ? 'text-emerald-500' : 'text-red-500'}`}>
                            {toast.type === 'success' ? <CheckCircle className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
                        </div>
                        <div className="flex-1">
                            <h4 className="text-sm font-bold text-slate-800">{toast.title}</h4>
                            <p className="text-xs text-slate-500 mt-1 leading-relaxed">{toast.message}</p>
                        </div>
                        <button onClick={() => setToasts(t => t.filter(i => i.id !== toast.id))} className="text-slate-400 hover:text-slate-600">
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                ))}
            </div>

        </main>
      </div>
    </div>
  );
};

export default App;
