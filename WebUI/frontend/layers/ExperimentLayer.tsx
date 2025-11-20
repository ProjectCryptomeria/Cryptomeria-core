
import React, { useState, useRef, useEffect } from 'react';
import { AllocatorStrategy, TransmitterStrategy, ActiveExperimentState, ExperimentConfig, UserAccount, ExperimentScenario } from '../types';
import { Play, Save, Calculator, Settings2, FileText, X, Upload, User, AlertTriangle, Lock } from 'lucide-react';

interface ExperimentLayerProps {
    activeExperiment: ActiveExperimentState;
    users: UserAccount[];
    scenarios: ExperimentScenario[];
    deployedNodeCount: number;
    onRunExperiment: (config: ExperimentConfig, scenarioName: string, estimatedCost: number) => void;
    onSaveScenario: (name: string, config: ExperimentConfig) => void;
    notify: (type: 'success' | 'error', title: string, message: string) => void;
}

const ExperimentLayer: React.FC<ExperimentLayerProps> = ({ activeExperiment, users, scenarios, deployedNodeCount, onRunExperiment, onSaveScenario, notify }) => {
  // Local Configuration State
  const [allocator, setAllocator] = useState(AllocatorStrategy.ROUND_ROBIN);
  const [transmitter, setTransmitter] = useState(TransmitterStrategy.ONE_BY_ONE);
  const [uploadType, setUploadType] = useState<'Virtual' | 'Real'>('Virtual');
  const [scenarioName, setScenarioName] = useState("");
  const [selectedLoadScenario, setSelectedLoadScenario] = useState("");
  
  // New Fields & Validation State
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [targetChains, setTargetChains] = useState<Set<string>>(new Set());
  
  // Virtual Config
  const [sizeMB, setSizeMB] = useState(1024);
  const [chunkSizeKB, setChunkSizeKB] = useState(64);
  const [files, setFiles] = useState(100);

  const [shouldFail, setShouldFail] = useState(false);

  // Simulation State
  const [estimatedCost, setEstimatedCost] = useState<number>(0);
  const [isSimulationValid, setIsSimulationValid] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null); // New: Separate error state

  // Logs View State
  const [showLogs, setShowLogs] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Initialize targets based on deployed nodes if empty
  useEffect(() => {
      if (targetChains.size === 0 && deployedNodeCount > 0) {
          setTargetChains(new Set(["datachain-0"]));
      }
  }, [deployedNodeCount]);

  // Reset simulation validity when config changes
  useEffect(() => {
      setIsSimulationValid(false);
      setBalanceError(null); // Clear balance error on config change
      // Do not reset estimatedCost to 0 visualy, but it's effectively invalid
  }, [allocator, transmitter, uploadType, selectedUserId, targetChains, sizeMB, chunkSizeKB, files, shouldFail]);

  // Auto-scroll logs
  useEffect(() => {
    if (showLogs) {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [activeExperiment.logs, showLogs]);

  const toggleTarget = (chain: string) => {
      const next = new Set(targetChains);
      if (next.has(chain)) next.delete(chain);
      else next.add(chain);
      setTargetChains(next);
  };

  const handleSelectAllTargets = () => {
      const all = new Set<string>();
      for(let i=0; i<deployedNodeCount; i++) {
          all.add(`datachain-${i}`);
      }
      setTargetChains(all);
  };

  const handleDeselectAllTargets = () => {
      setTargetChains(new Set());
  };

  const calculateCost = () => {
    // Mock Formula: (SizeMB * 2) + (TargetNodes * 100)
    return Math.floor(sizeMB * 2.5 + targetChains.size * 100);
  };

  const handleSimulate = () => {
      // 1. Validation
      if (!selectedUserId) {
          notify('error', '設定エラー', '実行アカウントを選択してください。');
          return;
      }
      if (targetChains.size === 0) {
          notify('error', '設定エラー', 'ターゲットチェーンを少なくとも1つ選択してください。');
          return;
      }
      if (uploadType === 'Virtual') {
          if (sizeMB <= 0 || chunkSizeKB <= 0 || files <= 0) {
               notify('error', '設定エラー', 'データ生成パラメータに不正な値が含まれています。');
               return;
          }
      }

      // 2. Cost Calculation (Always do this first)
      const cost = calculateCost();
      setEstimatedCost(cost);

      // 3. Balance Check
      const user = users.find(u => u.id === selectedUserId);
      if (!user) return;
      
      if (user.balance < cost) {
          // Show the cost but warn and keep invalid
          const errorMsg = `アカウント残高が足りません。(必要: ${cost.toLocaleString()} TKN, 現在: ${user.balance.toLocaleString()} TKN)`;
          setBalanceError(errorMsg);
          notify('error', '残高不足', errorMsg);
          setIsSimulationValid(false);
          return;
      }

      notify('success', '試算完了', `コスト試算が完了しました。実験を開始できます。`);
      setIsSimulationValid(true);
      setBalanceError(null);
  };

  const handleRun = () => {
      if (!isSimulationValid) return;

      const config: ExperimentConfig = {
          allocator,
          transmitter,
          targetChains: Array.from(targetChains),
          uploadType,
          virtualConfig: {
              sizeMB,
              chunkSizeKB,
              files
          },
          userId: selectedUserId,
          shouldFail: shouldFail
      };
      onRunExperiment(config, scenarioName || "名称未設定シナリオ", estimatedCost);
  };

  const handleSave = () => {
      if (!scenarioName) {
          notify('error', '保存エラー', 'シナリオ名を入力してください。');
          return;
      }
      const config: ExperimentConfig = {
          allocator,
          transmitter,
          targetChains: Array.from(targetChains),
          uploadType,
          virtualConfig: { sizeMB, chunkSizeKB, files },
          userId: selectedUserId, // Optional to save
          shouldFail
      };
      onSaveScenario(scenarioName, config);
  };

  const handleLoadScenario = () => {
      if (!selectedLoadScenario) return;
      if (activeExperiment.isRunning) return; // Guard

      const scenario = scenarios.find(s => s.id === selectedLoadScenario);
      if (!scenario) return;

      // Apply Config
      setAllocator(scenario.config.allocator);
      setTransmitter(scenario.config.transmitter);
      setUploadType(scenario.config.uploadType);
      if (scenario.config.virtualConfig) {
          setSizeMB(scenario.config.virtualConfig.sizeMB);
          setChunkSizeKB(scenario.config.virtualConfig.chunkSizeKB);
          setFiles(scenario.config.virtualConfig.files);
      }
      // Filter target chains to only include ones that currently exist
      const validTargets = new Set(scenario.config.targetChains.filter(chain => {
          // rudimentary check: assumes format "datachain-N"
          const num = parseInt(chain.split('-')[1]);
          return num < deployedNodeCount;
      }));
      setTargetChains(validTargets);
      
      setScenarioName(scenario.name);
      setShouldFail(scenario.config.shouldFail || false);
      
      // Reset simulation
      setIsSimulationValid(false);
      setBalanceError(null);

      notify('success', '読み込み完了', `シナリオ "${scenario.name}" を設定に反映しました。`);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 relative">
        {/* Logs Modal Overlay */}
        {showLogs && (
            <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="bg-slate-900 w-full max-w-2xl rounded-xl shadow-2xl border border-slate-700 flex flex-col max-h-[80vh]">
                    <div className="flex items-center justify-between p-4 border-b border-slate-700">
                        <div className="flex items-center gap-2 text-slate-100 font-bold">
                            <FileText className="w-5 h-5 text-blue-400" />
                            実行ログ
                        </div>
                        <button onClick={() => setShowLogs(false)} className="text-slate-400 hover:text-white">
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 font-mono text-sm text-slate-300 space-y-1 custom-scrollbar">
                        {activeExperiment.logs.length === 0 && <div className="text-slate-500 italic">ログはまだありません...</div>}
                        {activeExperiment.logs.map((log, i) => (
                            <div key={i} className={`break-all border-l-2 pl-2 ${log.includes('[ERROR]') ? 'border-red-500 text-red-200' : 'border-blue-900'}`}>
                                {log}
                            </div>
                        ))}
                        <div ref={logEndRef} />
                    </div>
                </div>
            </div>
        )}

        {/* Main Configuration */}
        <div className="lg:col-span-8 space-y-6">
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                <div className="flex items-center gap-2 mb-6 pb-4 border-b border-slate-100">
                    <Settings2 className="w-5 h-5 text-blue-600" />
                    <h2 className="text-lg font-bold text-slate-800">実験設定</h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                    {/* User & Strategy */}
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">実行アカウント</label>
                            <div className="relative">
                                <User className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
                                <select 
                                    value={selectedUserId}
                                    onChange={(e) => setSelectedUserId(e.target.value)}
                                    className="w-full pl-9 p-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none font-mono"
                                >
                                    <option value="">-- 選択してください --</option>
                                    {users.map(u => (
                                        <option key={u.id} value={u.id}>
                                            {u.address.substring(0, 12)}... ({u.balance.toLocaleString()} TKN)
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">アロケーター戦略</label>
                            <select 
                                value={allocator}
                                onChange={(e) => setAllocator(e.target.value as AllocatorStrategy)}
                                className="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                            >
                                {Object.values(AllocatorStrategy).map(s => (
                                    <option key={s} value={s}>{s}</option>
                                ))}
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">送信戦略</label>
                            <select 
                                value={transmitter}
                                onChange={(e) => setTransmitter(e.target.value as TransmitterStrategy)}
                                className="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                            >
                                {Object.values(TransmitterStrategy).map(s => (
                                    <option key={s} value={s}>{s}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Target Selection */}
                    <div className="bg-slate-50 p-4 rounded-lg border border-slate-200 flex flex-col">
                        <div className="flex justify-between items-center mb-2">
                             <label className="block text-sm font-medium text-slate-700">ターゲットチェーン</label>
                             <div className="flex gap-2">
                                 <button onClick={handleSelectAllTargets} className="text-[10px] text-blue-600 hover:underline cursor-pointer">全て選択</button>
                                 <span className="text-slate-300 text-[10px]">|</span>
                                 <button onClick={handleDeselectAllTargets} className="text-[10px] text-slate-500 hover:underline cursor-pointer">選択を外す</button>
                             </div>
                        </div>
                        {deployedNodeCount > 0 ? (
                            <div className="space-y-2 flex-1 overflow-y-auto pr-2 custom-scrollbar max-h-[180px]">
                                {Array.from({length: deployedNodeCount}, (_, i) => i).map(i => {
                                    const chainId = `datachain-${i}`;
                                    return (
                                        <label key={i} className={`flex items-center gap-3 bg-white p-2 rounded border cursor-pointer transition-colors ${targetChains.has(chainId) ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-blue-300'}`}>
                                            <input 
                                                type="checkbox" 
                                                checked={targetChains.has(chainId)}
                                                onChange={() => toggleTarget(chainId)}
                                                className="w-4 h-4 text-blue-600 rounded" 
                                            />
                                            <div className="flex-1">
                                                <div className="text-sm font-mono font-medium">{chainId}</div>
                                                <div className="text-[10px] text-slate-500">Height: 1204{i}</div>
                                            </div>
                                            <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                                        </label>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-xs text-center p-4">
                                <AlertTriangle className="w-6 h-6 mb-2" />
                                <p>稼働中のノードがありません。<br/>Deployment層でデプロイしてください。</p>
                            </div>
                        )}
                    </div>
                </div>

                {/* Upload Config */}
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-3">アップロード設定</label>
                    <div className="flex border-b border-slate-200 mb-4">
                        <button 
                            onClick={() => setUploadType('Virtual')}
                            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                                uploadType === 'Virtual' ? 'text-blue-600 border-blue-600' : 'text-slate-500 border-transparent hover:text-slate-700'
                            }`}
                        >
                            仮想データ生成
                        </button>
                        <button 
                             onClick={() => setUploadType('Real')}
                             className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                                uploadType === 'Real' ? 'text-blue-600 border-blue-600' : 'text-slate-500 border-transparent hover:text-slate-700'
                            }`}
                        >
                            実ファイル
                        </button>
                    </div>

                    {uploadType === 'Virtual' ? (
                        <div className="grid grid-cols-3 gap-4 animate-in fade-in duration-300">
                            <div>
                                 <label className="text-xs text-slate-500 uppercase font-bold">合計サイズ (MB)</label>
                                 <input 
                                    type="number" 
                                    value={sizeMB}
                                    onChange={(e) => setSizeMB(Number(e.target.value))}
                                    className="w-full mt-1 p-2 border rounded text-sm" 
                                 />
                            </div>
                            <div>
                                 <label className="text-xs text-slate-500 uppercase font-bold">チャンクサイズ (KB)</label>
                                 <input 
                                    type="number" 
                                    value={chunkSizeKB}
                                    onChange={(e) => setChunkSizeKB(Number(e.target.value))}
                                    className="w-full mt-1 p-2 border rounded text-sm" 
                                />
                            </div>
                            <div>
                                 <label className="text-xs text-slate-500 uppercase font-bold">ファイル数</label>
                                 <input 
                                    type="number" 
                                    value={files}
                                    onChange={(e) => setFiles(Number(e.target.value))}
                                    className="w-full mt-1 p-2 border rounded text-sm" 
                                />
                            </div>
                        </div>
                    ) : (
                        <div className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center animate-in fade-in duration-300 bg-slate-50 hover:bg-slate-100 transition-colors cursor-pointer">
                            <Upload className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                            <p className="text-slate-600 text-sm font-medium">ここにファイルをドラッグ＆ドロップ</p>
                            <p className="text-slate-400 text-xs mt-1">またはクリックして選択</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Active Experiment Monitor (Visible if logs exist or running) */}
            {(activeExperiment.logs.length > 0) && (
                <div className="bg-slate-900 text-white p-6 rounded-xl shadow-lg animate-in fade-in slide-in-from-bottom-4 relative overflow-hidden">
                    <div className="flex justify-between items-end mb-2 relative z-10">
                        <span className={`font-mono text-sm md:text-base ${activeExperiment.statusMessage.includes('エラー') ? 'text-red-400' : 'text-emerald-400'}`}>
                            {activeExperiment.statusMessage}
                        </span>
                        <span className="font-bold text-2xl">{activeExperiment.progress}%</span>
                    </div>
                    <div className="w-full bg-slate-700 rounded-full h-3 overflow-hidden relative z-10 mb-4">
                        <div 
                            className={`h-3 transition-all duration-300 ease-out ${activeExperiment.statusMessage.includes('エラー') ? 'bg-red-500' : 'bg-gradient-to-r from-blue-500 to-emerald-400'}`}
                            style={{ width: `${activeExperiment.progress}%` }}
                        ></div>
                    </div>
                    <div className="flex justify-end relative z-10">
                        <button 
                            onClick={() => setShowLogs(true)}
                            className="text-xs bg-slate-800 hover:bg-slate-700 border border-slate-600 px-3 py-1.5 rounded flex items-center gap-2 transition-colors"
                        >
                            <FileText className="w-3 h-3" />
                            ログを表示
                        </button>
                    </div>
                </div>
            )}
        </div>

        {/* Sidebar Actions */}
        <div className="lg:col-span-4 space-y-6">
            {/* Simulation Controls */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                <div className="flex items-center gap-2 mb-4 text-slate-700 font-bold">
                    <AlertTriangle className="w-5 h-5 text-orange-500" />
                    シミュレーション設定
                </div>
                <label className="flex items-center gap-3 p-3 bg-orange-50 border border-orange-100 rounded-lg cursor-pointer hover:bg-orange-100 transition">
                    <input 
                        type="checkbox" 
                        checked={shouldFail} 
                        onChange={(e) => setShouldFail(e.target.checked)} 
                        className="w-4 h-4 text-red-500 rounded focus:ring-red-400" 
                    />
                    <div>
                        <div className="text-sm font-bold text-orange-800">意図的なエラー発生</div>
                        <div className="text-xs text-orange-600">実験を65%で強制失敗させます</div>
                    </div>
                </label>
            </div>

            {/* Cost Estimator */}
            <div className="bg-slate-50 p-6 rounded-xl border border-slate-200">
                <div className="flex items-center gap-2 mb-4 text-slate-700 font-bold">
                    <Calculator className="w-5 h-5" />
                    コスト試算
                </div>
                
                {(estimatedCost > 0) && (
                     <div className="space-y-3 mb-6 animate-in fade-in">
                        <div className="flex justify-between text-sm">
                            <span className="text-slate-500">予想Tx数</span>
                            <span className="font-mono">{(sizeMB * 16).toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                            <span className="text-slate-500">予想ガス代</span>
                            <span className="font-mono">{estimatedCost.toLocaleString()} TKN</span>
                        </div>
                        <div className="pt-3 border-t border-slate-200 flex justify-between font-bold text-slate-800">
                            <span>合計コスト</span>
                            <span>{estimatedCost.toLocaleString()} TKN</span>
                        </div>
                    </div>
                )}
                
                {/* Balance Error Message */}
                {balanceError && (
                     <div className="mb-4 text-xs text-red-500 bg-red-50 p-2 rounded border border-red-100">
                        ※ {balanceError}
                     </div>
                )}

                {/* Settings Changed Warning (Not an error, just prompt to re-simulate) */}
                {!isSimulationValid && !balanceError && (
                     <div className="mb-4 text-xs text-slate-500 bg-slate-200 p-2 rounded border border-slate-300">
                        ※ 設定が変更されました。再試算を行ってください。
                     </div>
                )}
                
                <button 
                    onClick={handleSimulate}
                    className="w-full py-2 bg-white border border-slate-300 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-100 transition-colors mb-3"
                >
                    コストを試算 (再計算)
                </button>
            </div>

            {/* Actions */}
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 space-y-4">
                <button 
                    onClick={handleRun}
                    disabled={!isSimulationValid || activeExperiment.isRunning}
                    className={`w-full py-3 rounded-lg text-white font-bold shadow-md flex items-center justify-center gap-2 transition-all ${
                        !isSimulationValid || activeExperiment.isRunning ? 'bg-slate-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 hover:shadow-lg transform hover:-translate-y-0.5'
                    }`}
                    title={!isSimulationValid ? "先にコスト試算を行ってください" : ""}
                >
                    <Play className="w-5 h-5 fill-current" />
                    {activeExperiment.isRunning ? '実験実行中...' : '実験開始'}
                </button>
                
                <div className="pt-4 border-t border-slate-100 space-y-3">
                    <div>
                        <label className="text-xs font-bold text-slate-400 uppercase mb-1 block">シナリオ保存</label>
                        <input 
                            type="text" 
                            value={scenarioName}
                            onChange={(e) => setScenarioName(e.target.value)}
                            placeholder="シナリオ名を入力..." 
                            className="w-full p-2 text-sm border border-slate-200 rounded bg-slate-50 mb-2 outline-none focus:border-blue-400"
                        />
                        <button 
                            onClick={handleSave}
                            className="w-full py-2 border border-slate-200 text-slate-600 rounded-lg font-medium hover:bg-slate-50 flex items-center justify-center gap-2 transition-colors text-sm"
                        >
                            <Save className="w-4 h-4" />
                            現在の設定を保存
                        </button>
                    </div>
                </div>

                <div className={`pt-4 border-t border-slate-100 transition-opacity ${activeExperiment.isRunning ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
                    <label className="text-xs font-bold text-slate-400 uppercase mb-2 block flex justify-between">
                        シナリオ読み込み
                        {activeExperiment.isRunning && <Lock className="w-3 h-3 text-slate-400" />}
                    </label>
                    <div className="flex gap-2">
                        <select 
                            value={selectedLoadScenario}
                            onChange={(e) => setSelectedLoadScenario(e.target.value)}
                            disabled={activeExperiment.isRunning}
                            className="flex-1 p-2 text-sm border border-slate-200 rounded bg-slate-50 outline-none focus:border-blue-400 disabled:cursor-not-allowed"
                        >
                            <option value="">-- 選択 --</option>
                            {scenarios.map(s => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                        </select>
                        <button 
                            onClick={handleLoadScenario}
                            disabled={activeExperiment.isRunning}
                            className="px-3 py-2 bg-slate-100 text-slate-600 rounded border border-slate-200 hover:bg-slate-200 text-sm font-medium whitespace-nowrap disabled:cursor-not-allowed"
                        >
                            読み込み
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>
  );
};

export default ExperimentLayer;
