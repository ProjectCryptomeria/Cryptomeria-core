import React, { useState, useRef, useEffect } from 'react';
import { AppLayer, UserAccount, SystemAccount, ExperimentResult, ActiveExperimentState, ExperimentConfig, ExperimentPreset, Toast, NotificationItem } from './types';
import { NAV_ITEMS } from './constants';
import { generateMockUsers, generateMockResults, generateMockPresets, generateSystemAccounts } from './services/mockData';
import MonitoringLayer from './layers/MonitoringLayer';
import DeploymentLayer from './layers/DeploymentLayer';
import EconomyLayer from './layers/EconomyLayer';
import ExperimentLayer from './layers/ExperimentLayer';
import LibraryLayer from './layers/LibraryLayer';
import PresetLayer from './layers/PresetLayer';
import { LayoutDashboard, Bell, CheckCircle, AlertTriangle, X, Info, ChevronRight } from 'lucide-react';

/**
 * App Component
 * 
 * アプリケーションのエントリーポイント。
 * レイアウトの骨組み（Sidebar, Header, Main Content）を定義し、
 * 状態管理（ユーザー、システムアカウント、実験結果）を行います。
 * 
 * @design: 全体的にフラットでモダンな構成。サイドバーは視覚的に分離せず、
 * コンテンツの一部のように見せることで広がりを持たせています。
 */
const App: React.FC = () => {
  // --- State Management ---
  const [activeLayer, setActiveLayer] = useState<AppLayer>(AppLayer.MONITORING);
  
  // Infrastructure State
  const [deployedNodeCount, setDeployedNodeCount] = useState<number>(5);
  const [isDockerBuilt, setIsDockerBuilt] = useState<boolean>(false);

  // Economy State
  const [users, setUsers] = useState<UserAccount[]>(generateMockUsers());
  const [systemAccounts, setSystemAccounts] = useState<SystemAccount[]>(generateSystemAccounts(5));

  // Library State
  const [results, setResults] = useState<ExperimentResult[]>(generateMockResults());

  // Preset State
  const [presets, setPresets] = useState<ExperimentPreset[]>(generateMockPresets());

  // Notification State
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  const notificationRef = useRef<HTMLDivElement>(null);

  // --- Effects ---
  
  // ノード数変更時のRelayer同期
  useEffect(() => {
      setSystemAccounts(prev => {
          const millionaire = prev.find(a => a.type === 'faucet_source');
          const newAccounts = generateSystemAccounts(deployedNodeCount);
          if (millionaire) {
              newAccounts[0].balance = millionaire.balance;
          }
          return newAccounts;
      });
  }, [deployedNodeCount]);

  // クリックアウトサイド検知（通知メニュー用）
  useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
          if (notificationRef.current && !notificationRef.current.contains(event.target as Node)) {
              setIsNotificationOpen(false);
          }
      };
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // --- Action Handlers ---

  const addToast = (type: 'success' | 'error', title: string, message: string) => {
    const id = Math.random().toString(36).substr(2, 9);
    const newNotification: NotificationItem = {
        id, type, title, message, timestamp: Date.now(), read: false 
    };

    setNotifications(prev => [newNotification, ...prev]);
    setToasts(prev => {
        const updated = [...prev, { id, type, title, message }];
        if (updated.length > 3) return updated.slice(updated.length - 3);
        return updated;
    });
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  };

  const clearNotifications = () => setNotifications([]);

  const handleCreateUser = () => {
    const newUser: UserAccount = {
      id: `u${Date.now()}`,
      address: `raid1${Math.random().toString(36).substring(7)}${Math.random().toString(36).substring(7)}`,
      balance: 0,
      role: 'client'
    };
    setUsers([...users, newUser]);
  };

  const handleFaucet = (targetId: string) => {
    const amount = 1000;
    const millionaire = systemAccounts.find(a => a.type === 'faucet_source');
    if (!millionaire || millionaire.balance < amount) {
        addToast('error', 'Faucet Error', 'System pool is empty.');
        return;
    }

    const userTarget = users.find(u => u.id === targetId);
    if (userTarget) {
        setUsers(users.map(u => u.id === targetId ? { ...u, balance: u.balance + amount } : u));
        setSystemAccounts(prev => prev.map(a => a.id === millionaire.id ? { ...a, balance: a.balance - amount } : a));
        addToast('success', 'Success', `Sent 1,000 TKN to ${userTarget.address.substring(0,8)}...`);
        return;
    }

    const sysTarget = systemAccounts.find(a => a.id === targetId);
    if (sysTarget) {
        setSystemAccounts(prev => prev.map(a => {
            if (a.id === millionaire.id) return { ...a, balance: a.balance - amount };
            if (a.id === targetId) return { ...a, balance: a.balance + amount };
            return a;
        }));
        addToast('success', 'Success', `Refilled 1,000 TKN to ${sysTarget.name}.`);
    }
  };

  const handleDeleteUser = (id: string) => setUsers(users.filter(u => u.id !== id));

  const handleSavePreset = (name: string, config: ExperimentConfig, generatorState?: any) => {
      const existingIndex = presets.findIndex(s => s.name === name);
      const newPreset: ExperimentPreset = {
          id: existingIndex >= 0 ? presets[existingIndex].id : crypto.randomUUID(),
          name, config, generatorState, lastModified: new Date().toISOString()
      };
      if (existingIndex >= 0) {
          const next = [...presets]; next[existingIndex] = newPreset; setPresets(next);
          addToast('success', 'Saved', `Preset "${name}" updated.`);
      } else {
          setPresets([...presets, newPreset]);
          addToast('success', 'Saved', `Preset "${name}" created.`);
      }
  };

  const handleDeletePreset = (id: string) => { setPresets(prev => prev.filter(s => s.id !== id)); addToast('success', 'Deleted', 'Preset removed.'); };
  const handleDeleteResult = (id: string) => { setResults(results.filter(r => r.id !== id)); addToast('success', 'Deleted', 'Result log removed.'); };
  const handleRegisterResult = (result: ExperimentResult) => setResults(prev => [result, ...prev]);

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-slate-50 text-slate-900 font-sans selection:bg-indigo-100 selection:text-indigo-900">
      
      {/* --- Header --- */}
      <header className="h-20 bg-white px-8 flex items-center justify-between z-40 shrink-0 border-b border-slate-100">
        <div className="flex items-center gap-4">
           <div className="bg-gradient-to-br from-blue-600 to-indigo-600 p-2.5 rounded-2xl shadow-lg shadow-blue-200">
             <LayoutDashboard className="text-white w-6 h-6" />
           </div>
           <div>
               <h1 className="font-extrabold text-2xl tracking-tight text-slate-800 leading-none">RaidChain <span className="text-slate-400 font-light">WebUI</span></h1>
           </div>
        </div>

        <div className="flex items-center gap-6">
             {/* Status Indicator */}
             <div className="hidden md:flex items-center gap-3 px-4 py-2 bg-slate-50 rounded-full border border-slate-100">
                 <div className={`w-2.5 h-2.5 rounded-full shadow-sm ${deployedNodeCount > 0 ? 'bg-emerald-500 shadow-emerald-200 animate-pulse' : 'bg-red-500 shadow-red-200'}`}></div>
                 <span className="text-xs font-bold text-slate-600 uppercase tracking-wide">
                     {deployedNodeCount > 0 ? 'System Online' : 'System Offline'}
                 </span>
             </div>

             {/* Notification Center */}
             <div className="relative" ref={notificationRef}>
                 <button 
                    className="relative p-3 text-slate-400 hover:text-slate-600 transition-all hover:bg-slate-100 rounded-2xl hover:shadow-sm active:scale-95"
                    onClick={() => setIsNotificationOpen(!isNotificationOpen)}
                 >
                     <Bell className="w-6 h-6" />
                     {notifications.filter(n => !n.read).length > 0 && (
                         <span className="absolute top-2.5 right-2.5 w-2.5 h-2.5 bg-red-500 rounded-full ring-2 ring-white"></span>
                     )}
                 </button>

                 {/* Dropdown */}
                 {isNotificationOpen && (
                     <div className="absolute right-0 mt-4 w-96 bg-white rounded-3xl shadow-2xl border border-slate-100 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200 z-50">
                         <div className="px-6 py-4 border-b border-slate-50 flex justify-between items-center bg-slate-50/50">
                             <h3 className="font-bold text-slate-800">Notifications</h3>
                             <button onClick={clearNotifications} className="text-xs font-bold text-blue-600 hover:text-blue-800">Clear All</button>
                         </div>
                         <div className="max-h-96 overflow-y-auto custom-scrollbar p-2 space-y-1">
                             {notifications.length === 0 ? (
                                 <div className="p-10 text-center text-slate-400 text-sm font-medium">No new notifications</div>
                             ) : (
                                 notifications.map(n => (
                                     <div key={n.id} className="px-4 py-3 hover:bg-slate-50 rounded-2xl transition-colors cursor-default group">
                                         <div className="flex gap-4 items-start">
                                             <div className={`mt-1 p-1.5 rounded-full ${n.type === 'success' ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'}`}>
                                                 {n.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                                             </div>
                                             <div className="flex-1">
                                                 <div className="text-sm font-bold text-slate-800">{n.title}</div>
                                                 <div className="text-xs text-slate-500 mt-0.5 leading-relaxed">{n.message}</div>
                                                 <div className="text-[10px] text-slate-400 mt-2 font-medium text-right group-hover:text-slate-500">
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

      {/* --- Main Container --- */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Sidebar */}
        <nav className="w-72 bg-white flex flex-col py-8 px-4 gap-2 shrink-0 overflow-y-auto border-r border-slate-100">
            <div className="px-4 mb-4 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Navigation</div>
            {NAV_ITEMS.map(item => {
                const isActive = activeLayer === item.id;
                return (
                    <button
                        key={item.id}
                        onClick={() => setActiveLayer(item.id)}
                        className={`
                            relative px-5 py-4 rounded-2xl text-left transition-all duration-300 flex items-center gap-4 group
                            ${isActive 
                                ? 'bg-indigo-50 text-indigo-700 shadow-sm scale-[1.02]' 
                                : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800 hover:scale-[1.01]'
                            }
                        `}
                    >
                        <item.icon className={`w-6 h-6 transition-colors ${isActive ? 'text-indigo-600' : 'text-slate-400 group-hover:text-slate-600'}`} />
                        <div className="flex-1">
                            <div className={`font-bold text-sm ${isActive ? 'text-indigo-900' : 'text-slate-700'}`}>{item.label}</div>
                            <div className={`text-[10px] font-medium mt-0.5 transition-colors ${isActive ? 'text-indigo-400' : 'text-slate-400'}`}>{item.subLabel}</div>
                        </div>
                        {isActive && <ChevronRight className="w-4 h-4 text-indigo-400" />}
                    </button>
                );
            })}
            
            <div className="mt-auto pt-8 px-2">
                <div className="bg-slate-900 p-5 rounded-3xl shadow-xl relative overflow-hidden group cursor-default">
                    <div className="absolute top-0 right-0 p-3 opacity-10 group-hover:opacity-20 transition-opacity">
                        <Info className="w-16 h-16 text-white" />
                    </div>
                    <div className="relative z-10">
                        <div className="text-xs font-bold text-slate-400 mb-2 uppercase tracking-wider">Cluster Info</div>
                        <div className="space-y-1.5">
                            <div className="flex justify-between text-xs">
                                <span className="text-slate-500">Provider</span>
                                <span className="font-bold text-slate-200">Minikube</span>
                            </div>
                            <div className="flex justify-between text-xs">
                                <span className="text-slate-500">Ver</span>
                                <span className="font-bold text-slate-200">v1.28.3</span>
                            </div>
                            <div className="flex justify-between text-xs">
                                <span className="text-slate-500">Memory</span>
                                <span className="font-bold text-emerald-400">8192MB</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </nav>

        {/* Content Area */}
        <main className="flex-1 bg-slate-50/50 relative overflow-hidden">
            
            {/* Layer Render */}
            <div className="h-full w-full p-8 overflow-y-auto custom-scrollbar">
                <div className="max-w-[1600px] mx-auto h-full">
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

                    {activeLayer === AppLayer.PRESET && (
                        <PresetLayer 
                            presets={presets}
                            onDeletePreset={handleDeletePreset}
                        />
                    )}
                    
                    {activeLayer === AppLayer.EXPERIMENT && (
                        <ExperimentLayer 
                            users={users}
                            presets={presets}
                            deployedNodeCount={deployedNodeCount}
                            onRegisterResult={handleRegisterResult}
                            onSavePreset={handleSavePreset}
                            notify={addToast}
                        />
                    )}
                    
                    {activeLayer === AppLayer.LIBRARY && <LibraryLayer results={results} onDeleteResult={handleDeleteResult} />}
                </div>
            </div>

            {/* Global Toasts */}
            <div className="fixed bottom-8 left-8 z-[100] flex flex-col gap-4 pointer-events-none w-80">
                {toasts.map(toast => (
                    <div key={toast.id} className="bg-white rounded-2xl shadow-2xl border border-slate-100 p-5 w-full animate-in slide-in-from-left-10 fade-in duration-500 pointer-events-auto flex items-start gap-4 ring-1 ring-black/5">
                        <div className={`mt-0.5 p-2 rounded-full ${toast.type === 'success' ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'}`}>
                            {toast.type === 'success' ? <CheckCircle className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
                        </div>
                        <div className="flex-1">
                            <h4 className="text-sm font-bold text-slate-800">{toast.title}</h4>
                            <p className="text-xs text-slate-500 mt-1 leading-relaxed font-medium">{toast.message}</p>
                        </div>
                        <button onClick={() => setToasts(t => t.filter(i => i.id !== toast.id))} className="text-slate-300 hover:text-slate-500 transition-colors">
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