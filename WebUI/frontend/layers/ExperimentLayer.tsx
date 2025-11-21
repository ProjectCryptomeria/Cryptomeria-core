import React, { useState, useRef, useEffect } from 'react';
import { AllocatorStrategy, TransmitterStrategy, ActiveExperimentState, ExperimentConfig, UserAccount, ExperimentScenario, RealFileConfig } from '../types';
import { Play, Save, Calculator, Settings2, FileText, X, Upload, User, AlertTriangle, Lock, Folder, File, ChevronRight, ChevronLeft, Database, HardDrive, FolderInput, FileInput, CheckCircle2 } from 'lucide-react';

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
  // Layout State
  const [isDrawerOpen, setIsDrawerOpen] = useState(true);

  // Local Configuration State
  const [allocator, setAllocator] = useState(AllocatorStrategy.ROUND_ROBIN);
  const [transmitter, setTransmitter] = useState(TransmitterStrategy.ONE_BY_ONE);
  const [uploadType, setUploadType] = useState<'Virtual' | 'Real'>('Virtual');
  const [projectName, setProjectName] = useState(""); 
  
  // Scenario Load/Save State
  const [scenarioNameInput, setScenarioNameInput] = useState(""); 
  const [selectedLoadScenario, setSelectedLoadScenario] = useState("");
  
  // Validation State
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [targetChains, setTargetChains] = useState<Set<string>>(new Set());
  
  // Virtual Config
  const [sizeMB, setSizeMB] = useState(1024);
  const [chunkSizeKB, setChunkSizeKB] = useState(64);
  const [files, setFiles] = useState(100);

  // Real Config State
  const [realConfig, setRealConfig] = useState<RealFileConfig | null>(null);
  const [rawFiles, setRawFiles] = useState<File[]>([]);
  const [isZipMode, setIsZipMode] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  // Refs for inputs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Simulation State
  const [shouldFail, setShouldFail] = useState(false);
  const [estimatedCost, setEstimatedCost] = useState<number>(0);
  const [isSimulationValid, setIsSimulationValid] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  // Logs View State
  const [showLogs, setShowLogs] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Initialize targets
  useEffect(() => {
      if (targetChains.size === 0 && deployedNodeCount > 0) {
          setTargetChains(new Set(["datachain-0"]));
      }
  }, [deployedNodeCount]);

  // Reset simulation validity on config change
  useEffect(() => {
      setIsSimulationValid(false);
      setBalanceError(null);
  }, [allocator, transmitter, uploadType, selectedUserId, targetChains, sizeMB, chunkSizeKB, files, shouldFail, realConfig, projectName]);

  // Auto-scroll logs
  useEffect(() => {
    if (showLogs) {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [activeExperiment.logs, showLogs]);

  // --- Logic: Real File Tree Generation ---

  const generateTreeStructure = (files: File[], isZip: boolean, rootName: string) => {
    // Ensure rootName has a fallback
    const root = rootName.trim() || "ProjectRoot";

    if (isZip) {
        // Mock structure for ZIP, using dynamic root name
        return `${root}/\n├── assets/\n│   ├── images/\n│   │   ├── logo.png\n│   │   └── background.jpg\n│   └── styles/\n│       └── main.css\n├── src/\n│   ├── index.js\n│   ├── utils.js\n│   └── components/\n│       ├── Header.js\n│       └── Footer.js\n├── package.json\n└── README.md`;
    }

    // Real file structure generation
    // 1. Build path list relative to the new rootName
    // When uploading a folder, webkitRelativePath looks like "FolderName/sub/file".
    // We want to replace "FolderName" with our `root` (projectName).
    // When uploading multiple files, webkitRelativePath is empty. We just list them under `root`.
    
    const paths = files.map(f => {
        if (f.webkitRelativePath) {
            // format: "OriginalRoot/sub/file.txt"
            const parts = f.webkitRelativePath.split('/');
            if (parts.length > 1) {
                parts.shift(); // Remove original root directory name
                return parts.join('/'); // Keep the rest of the path
            }
        }
        return f.name; // Fallback for flat files
    });

    // 2. Build Hierarchy Object
    const hierarchy: any = {};
    paths.forEach(path => {
        const parts = path.split('/');
        let current = hierarchy;
        parts.forEach((part) => {
            if (!current[part]) {
                current[part] = {};
            }
            current = current[part];
        });
    });

    // 3. Render ASCII Tree
    let output = `${root}/\n`;
    
    const renderNode = (node: any, prefix: string) => {
        const keys = Object.keys(node);
        keys.sort(); // Alphabetical sort
        
        keys.forEach((key, index) => {
            const isLastItem = index === keys.length - 1;
            const connector = isLastItem ? '└── ' : '├── ';
            const childPrefix = isLastItem ? '    ' : '│   ';
            
            // Check if leaf (file) or node (dir)
            const isLeaf = Object.keys(node[key]).length === 0;
            
            output += `${prefix}${connector}${key}${isLeaf ? '' : '/'}\n`;
            
            if (!isLeaf) {
                renderNode(node[key], prefix + childPrefix);
            }
        });
    };

    renderNode(hierarchy, "");
    return output;
  };

  // Re-generate structure when projectName or files change
  useEffect(() => {
      // Only regenerate if we have files or we are in zip mode (which uses mock structure)
      // If we loaded from a scenario (no rawFiles), we preserve the loaded string in realConfig (handled in handleLoadScenario)
      if (rawFiles.length > 0 || isZipMode) {
          const totalSizeMB = isZipMode 
            ? (rawFiles[0]?.size || 0) / (1024 * 1024) 
            : rawFiles.reduce((acc, f) => acc + f.size, 0) / (1024 * 1024);

          const count = isZipMode ? 12 : rawFiles.length;

          // Generate tree using current project name as root
          const tree = generateTreeStructure(rawFiles, isZipMode, projectName);

          setRealConfig({
              fileCount: count,
              totalSizeMB,
              structure: tree
          });
      }
  }, [projectName, rawFiles, isZipMode]);


  // --- Logic: File Handling ---

  const handleFilesSelected = (files: File[]) => {
      if (files.length === 0) return;

      // ZIP Detection: Single file ending in .zip
      const first = files[0];
      const isZip = files.length === 1 && first.name.toLowerCase().endsWith('.zip');
      
      setIsZipMode(isZip);
      setRawFiles(files);

      // Determine Initial Project Name logic
      let initialName = "";
      
      if (isZip) {
          // Case 1: ZIP File -> Use filename without extension
          initialName = first.name.replace(/\.zip$/i, '');
      } else if (first.webkitRelativePath) {
          // Case 2: Directory Upload -> Use the top-level folder name
          // webkitRelativePath example: "MyProject/src/index.js"
          initialName = first.webkitRelativePath.split('/')[0];
      } else {
          // Case 3: Single/Multiple Files (Flat) -> Use "Unknown Project-<RandomID>"
          const randomId = Math.random().toString(36).substring(2, 7).toUpperCase();
          initialName = `不明なプロジェクト-${randomId}`;
      }
      
      // Set the project name. This will trigger the useEffect to regenerate the tree with this new name.
      setProjectName(initialName);
  };

  const handleDrop = (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          handleFilesSelected(Array.from(e.dataTransfer.files));
      }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
          handleFilesSelected(Array.from(e.target.files));
      }
  };

  // --- Logic: Cost & Run ---

  const toggleTarget = (chain: string) => {
      const next = new Set(targetChains);
      if (next.has(chain)) next.delete(chain);
      else next.add(chain);
      setTargetChains(next);
  };

  const handleSelectAllTargets = () => {
    const all = new Set<string>();
    for(let i=0; i<deployedNodeCount; i++) all.add(`datachain-${i}`);
    setTargetChains(all);
  };

  const handleDeselectAllTargets = () => setTargetChains(new Set());

  const calculateCost = () => {
    let dataSize = 0;
    if (uploadType === 'Virtual') {
        dataSize = sizeMB;
    } else {
        dataSize = realConfig ? realConfig.totalSizeMB : 0;
    }
    // Simple cost formula
    return Math.floor(dataSize * 2.5 + targetChains.size * 100);
  };

  const handleSimulate = () => {
      // Validation
      if (!selectedUserId) {
          notify('error', '設定エラー', '実行アカウントを選択してください。');
          return;
      }
      if (!projectName) {
          notify('error', '設定エラー', 'プロジェクト名を入力してください。');
          return;
      }
      if (targetChains.size === 0) {
          notify('error', '設定エラー', 'ターゲットチェーンを選択してください。');
          return;
      }
      if (uploadType === 'Real' && !realConfig) {
          notify('error', '設定エラー', 'ファイルをアップロードしてください。');
          return;
      }

      const cost = calculateCost();
      setEstimatedCost(cost);

      const user = users.find(u => u.id === selectedUserId);
      if (!user) return;
      
      if (user.balance < cost) {
          const errorMsg = `残高不足 (必要: ${cost.toLocaleString()}, 現在: ${user.balance.toLocaleString()})`;
          setBalanceError(errorMsg);
          notify('error', '残高不足', errorMsg);
          setIsSimulationValid(false);
          return;
      }

      notify('success', '試算完了', 'コスト試算完了。実験を開始できます。');
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
          projectName,
          virtualConfig: uploadType === 'Virtual' ? { sizeMB, chunkSizeKB, files } : undefined,
          realConfig: uploadType === 'Real' && realConfig ? realConfig : undefined,
          userId: selectedUserId,
          shouldFail
      };
      onRunExperiment(config, projectName, estimatedCost);
  };

  const handleSave = () => {
      if (!scenarioNameInput) {
          notify('error', '保存エラー', 'シナリオ名を入力してください。');
          return;
      }
      const config: ExperimentConfig = {
          allocator,
          transmitter,
          targetChains: Array.from(targetChains),
          uploadType,
          projectName,
          virtualConfig: uploadType === 'Virtual' ? { sizeMB, chunkSizeKB, files } : undefined,
          realConfig: uploadType === 'Real' && realConfig ? realConfig : undefined,
          userId: selectedUserId, 
          shouldFail
      };
      onSaveScenario(scenarioNameInput, config);
  };

  const handleLoadScenario = () => {
      if (!selectedLoadScenario) return;
      if (activeExperiment.isRunning) return;

      const scenario = scenarios.find(s => s.id === selectedLoadScenario);
      if (!scenario) return;

      // Apply Config
      setAllocator(scenario.config.allocator);
      setTransmitter(scenario.config.transmitter);
      setUploadType(scenario.config.uploadType);
      setProjectName(scenario.config.projectName || scenario.name);
      
      if (scenario.config.virtualConfig) {
          setSizeMB(scenario.config.virtualConfig.sizeMB);
          setChunkSizeKB(scenario.config.virtualConfig.chunkSizeKB);
          setFiles(scenario.config.virtualConfig.files);
      }
      
      // Filter valid targets
      const validTargets = new Set(scenario.config.targetChains.filter(chain => {
          const num = parseInt(chain.split('-')[1]);
          return num < deployedNodeCount;
      }));
      setTargetChains(validTargets);
      
      setScenarioNameInput(scenario.name);
      setShouldFail(scenario.config.shouldFail || false);
      
      // Reset simulation
      setIsSimulationValid(false);
      setBalanceError(null);
      
      // For real files, restore config but we don't have the actual files
      if (scenario.config.uploadType === 'Real' && scenario.config.realConfig) {
          notify('success', '設定読み込み', '実ファイル設定を読み込みました。ファイル実体は再選択が必要です。');
          setRealConfig(scenario.config.realConfig);
          setRawFiles([]); // Clear raw files
      } else {
          notify('success', '読み込み完了', `シナリオ "${scenario.name}" を反映しました。`);
      }
  };

  return (
    <div className="flex h-[calc(100vh-140px)] relative overflow-hidden gap-6">
        
        {/* Hidden Inputs for File Upload */}
        <input 
            type="file" 
            ref={fileInputRef}
            className="hidden" 
            multiple
            onChange={handleFileInputChange} 
        />
        {/* Directory Upload Input with non-standard attributes */}
        <input 
            type="file" 
            ref={folderInputRef}
            className="hidden" 
            multiple
            {...({ webkitdirectory: "", directory: "" } as any)}
            onChange={handleFileInputChange} 
        />

        {/* Logs Modal */}
        {showLogs && (
            <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="bg-slate-900 w-full max-w-3xl rounded-xl shadow-2xl border border-slate-700 flex flex-col max-h-[80vh] animate-in zoom-in-95 duration-200">
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

        {/* Main Content Area (Config) */}
        <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-6 pb-10">
            
            {/* Active Experiment Monitor Banner */}
            {(activeExperiment.isRunning || activeExperiment.logs.length > 0) && (
                <div className="bg-slate-900 text-white p-6 rounded-xl shadow-lg relative overflow-hidden group transition-all">
                    <div className="flex justify-between items-end mb-2 relative z-10">
                         <div className="flex items-center gap-3">
                            {activeExperiment.isRunning && <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />}
                            <span className={`font-mono text-sm md:text-base ${activeExperiment.statusMessage.includes('エラー') ? 'text-red-400' : 'text-emerald-400'}`}>
                                {activeExperiment.statusMessage}
                            </span>
                         </div>
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
                            詳細ログを表示
                        </button>
                    </div>
                </div>
            )}

            <div className={`bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden ${activeExperiment.isRunning ? 'opacity-50 pointer-events-none' : ''}`}>
                <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
                    <Settings2 className="w-5 h-5 text-blue-600" />
                    <h2 className="text-lg font-bold text-slate-800">実験構成設定</h2>
                </div>
                
                <div className="p-6 space-y-8">
                    {/* Section 1: Basic Settings */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-4">
                            <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider">基本戦略</h3>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">実行アカウント <span className="text-red-500">*</span></label>
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
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">アロケーター</label>
                                    <select 
                                        value={allocator}
                                        onChange={(e) => setAllocator(e.target.value as AllocatorStrategy)}
                                        className="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm outline-none focus:border-blue-500"
                                    >
                                        {Object.values(AllocatorStrategy).map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">トランスミッター</label>
                                    <select 
                                        value={transmitter}
                                        onChange={(e) => setTransmitter(e.target.value as TransmitterStrategy)}
                                        className="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm outline-none focus:border-blue-500"
                                    >
                                        {Object.values(TransmitterStrategy).map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-4 flex flex-col">
                            <div className="flex justify-between items-center">
                                <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider">ターゲットチェーン <span className="text-red-500">*</span></h3>
                                <div className="flex gap-2">
                                    <button onClick={handleSelectAllTargets} className="text-[10px] bg-blue-50 text-blue-600 px-2 py-1 rounded hover:bg-blue-100">全選択</button>
                                    <button onClick={handleDeselectAllTargets} className="text-[10px] bg-slate-100 text-slate-500 px-2 py-1 rounded hover:bg-slate-200">解除</button>
                                </div>
                            </div>
                            <div className="flex-1 bg-slate-50 border border-slate-200 rounded-lg p-2 overflow-y-auto max-h-[160px] custom-scrollbar">
                                {deployedNodeCount > 0 ? (
                                    <div className="space-y-1">
                                        {Array.from({length: deployedNodeCount}, (_, i) => i).map(i => {
                                            const chainId = `datachain-${i}`;
                                            return (
                                                <label key={i} className={`flex items-center gap-3 p-2 rounded cursor-pointer transition-colors ${targetChains.has(chainId) ? 'bg-white shadow-sm border border-blue-200' : 'hover:bg-slate-100 border border-transparent'}`}>
                                                    <input 
                                                        type="checkbox" 
                                                        checked={targetChains.has(chainId)}
                                                        onChange={() => toggleTarget(chainId)}
                                                        className="w-4 h-4 text-blue-600 rounded" 
                                                    />
                                                    <div className="flex-1 flex justify-between items-center">
                                                        <span className="text-sm font-mono text-slate-700">{chainId}</span>
                                                        <span className="text-[10px] px-1.5 py-0.5 bg-emerald-100 text-emerald-600 rounded-full">Active</span>
                                                    </div>
                                                </label>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    <div className="h-full flex flex-col items-center justify-center text-slate-400 text-xs">
                                        <AlertTriangle className="w-6 h-6 mb-2 opacity-50" />
                                        稼働中のノードがありません
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Section 2: Data Configuration */}
                    <div className="space-y-4 pt-6 border-t border-slate-100">
                        <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                            <Database className="w-4 h-4" />
                            データ設定
                        </h3>
                        
                        <div className="bg-slate-50 p-1 rounded-lg inline-flex mb-4 border border-slate-200">
                            <button 
                                onClick={() => setUploadType('Virtual')}
                                className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${uploadType === 'Virtual' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                            >
                                仮想データ生成
                            </button>
                            <button 
                                onClick={() => setUploadType('Real')}
                                className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${uploadType === 'Real' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                            >
                                ファイルアップロード
                            </button>
                        </div>

                        {uploadType === 'Virtual' ? (
                            <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-6 animate-in fade-in">
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">プロジェクト名 <span className="text-red-500">*</span></label>
                                    <input 
                                        type="text" 
                                        value={projectName}
                                        onChange={(e) => setProjectName(e.target.value)}
                                        placeholder="例: my-virtual-experiment"
                                        className="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:border-blue-500"
                                    />
                                    <p className="text-xs text-slate-400 mt-1">実験データの識別子として使用されます。</p>
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                    <div>
                                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">合計データサイズ (MB)</label>
                                        <div className="relative">
                                            <input 
                                                type="number" 
                                                min="1"
                                                value={sizeMB} 
                                                onChange={(e) => setSizeMB(Number(e.target.value))}
                                                className="w-full p-2 pl-3 pr-10 border border-slate-300 rounded-lg text-sm outline-none focus:border-blue-500"
                                            />
                                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">MB</span>
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">チャンク分割サイズ (KB)</label>
                                        <div className="relative">
                                            <input 
                                                type="number"
                                                min="1" 
                                                value={chunkSizeKB} 
                                                onChange={(e) => setChunkSizeKB(Number(e.target.value))}
                                                className="w-full p-2 pl-3 pr-10 border border-slate-300 rounded-lg text-sm outline-none focus:border-blue-500"
                                            />
                                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">KB</span>
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">擬似ファイル数</label>
                                        <div className="relative">
                                            <input 
                                                type="number" 
                                                min="1"
                                                value={files} 
                                                onChange={(e) => setFiles(Number(e.target.value))}
                                                className="w-full p-2 pl-3 pr-10 border border-slate-300 rounded-lg text-sm outline-none focus:border-blue-500"
                                            />
                                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">Files</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-6 animate-in fade-in">
                                {/* Upload Area */}
                                <div 
                                    className={`border-2 border-dashed rounded-xl p-8 text-center transition-all ${
                                        isDragOver 
                                            ? 'border-blue-500 bg-blue-50' 
                                            : 'border-slate-300 bg-slate-50 hover:bg-slate-100 hover:border-blue-400'
                                    }`}
                                    onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                                    onDragLeave={() => setIsDragOver(false)}
                                    onDrop={handleDrop}
                                >
                                    <div className="flex flex-col items-center justify-center">
                                        <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mb-3">
                                            <Upload className="w-6 h-6" />
                                        </div>
                                        <p className="text-slate-700 font-medium text-base mb-1">ここにファイルまたはフォルダをドラッグ＆ドロップ</p>
                                        
                                        <div className="flex items-center gap-4 mt-4">
                                            <button 
                                                onClick={() => fileInputRef.current?.click()}
                                                className="px-4 py-2 bg-white border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50 hover:text-blue-600 flex items-center gap-2 transition-colors"
                                            >
                                                <FileInput className="w-4 h-4" />
                                                ファイルを選択
                                            </button>
                                            <span className="text-slate-400 text-xs">- or -</span>
                                            <button 
                                                onClick={() => folderInputRef.current?.click()}
                                                className="px-4 py-2 bg-white border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50 hover:text-blue-600 flex items-center gap-2 transition-colors"
                                            >
                                                <FolderInput className="w-4 h-4" />
                                                フォルダを選択
                                            </button>
                                        </div>

                                        {rawFiles.length > 0 && (
                                            <div className="mt-6 bg-blue-50 px-4 py-2 rounded-lg border border-blue-200 text-blue-700 text-sm flex items-center gap-2 shadow-sm">
                                                {isZipMode ? <File className="w-4 h-4" /> : <Folder className="w-4 h-4" />}
                                                {isZipMode ? rawFiles[0].name : `${rawFiles.length} ファイルを選択中`} 
                                                <span className="text-slate-500 text-xs ml-2">
                                                    ({(realConfig?.totalSizeMB || 0).toFixed(2)} MB)
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Project Name Input */}
                                <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
                                    <label className="block text-sm font-medium text-slate-700 mb-1">プロジェクト名 <span className="text-red-500">*</span></label>
                                    <input 
                                        type="text" 
                                        value={projectName}
                                        onChange={(e) => setProjectName(e.target.value)}
                                        placeholder="必須：プロジェクト名を入力"
                                        className="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:border-blue-500"
                                    />
                                    <p className="text-xs text-slate-400 mt-1">アップロードデータのルートディレクトリ名および識別子として使用されます。</p>
                                </div>

                                {/* Structure Preview */}
                                {realConfig && (
                                    <div className="bg-slate-900 rounded-lg p-4 shadow-inner border border-slate-700">
                                        <h4 className="text-slate-400 text-xs font-bold uppercase mb-2 flex items-center gap-2">
                                            <Folder className="w-4 h-4 text-yellow-500" />
                                            ディレクトリツリー
                                        </h4>
                                        <div className="bg-slate-950 rounded border border-slate-800 p-3 overflow-x-auto custom-scrollbar max-h-[300px]">
                                            <pre className="text-xs font-mono text-emerald-400 leading-relaxed whitespace-pre">
                                                {realConfig.structure}
                                            </pre>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>

        {/* Toggle Button for Drawer */}
        <button 
            onClick={() => setIsDrawerOpen(!isDrawerOpen)}
            className="absolute top-1/2 right-0 transform -translate-y-1/2 z-20 bg-white border border-slate-200 shadow-lg p-1.5 rounded-l-lg text-slate-500 hover:text-blue-600 transition-transform hover:-translate-x-1"
            style={{ right: isDrawerOpen ? '384px' : '0' }} // 384px = w-96
        >
            {isDrawerOpen ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
        </button>

        {/* Side Drawer (Actions) */}
        <div 
            className={`bg-white border-l border-slate-200 shadow-2xl flex flex-col h-full transition-all duration-300 ease-in-out z-30 ${isDrawerOpen ? 'w-96 opacity-100' : 'w-0 opacity-0 overflow-hidden'}`}
        >
            <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                <h3 className="font-bold text-slate-800 flex items-center gap-2">
                    <Calculator className="w-5 h-5 text-indigo-600" />
                    アクションパネル
                </h3>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
                
                {/* Cost Estimation Card */}
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 relative overflow-hidden group">
                     <div className="absolute top-0 right-0 w-20 h-20 bg-blue-50 rounded-bl-full -mr-10 -mt-10 transition-transform group-hover:scale-110"></div>
                     
                     <h4 className="text-sm font-bold text-slate-700 mb-4 flex items-center gap-2 relative z-10">
                         <Settings2 className="w-4 h-4 text-slate-400" />
                         コスト試算
                     </h4>
                     
                     <div className="space-y-3 relative z-10">
                         <div className="flex justify-between items-center text-sm">
                             <span className="text-slate-500">推定コスト</span>
                             <span className="font-bold font-mono text-lg text-slate-800">{estimatedCost.toLocaleString()} <span className="text-xs text-slate-400">TKN</span></span>
                         </div>
                         
                         {selectedUserId && (
                             <div className="flex justify-between items-center text-sm">
                                 <span className="text-slate-500">現在残高</span>
                                 <span className={`font-mono ${balanceError ? 'text-red-500 font-bold' : 'text-slate-600'}`}>
                                     {users.find(u => u.id === selectedUserId)?.balance.toLocaleString()} <span className="text-xs">TKN</span>
                                 </span>
                             </div>
                         )}

                         <button 
                             onClick={handleSimulate}
                             className="w-full py-2 mt-2 bg-blue-50 text-blue-600 border border-blue-100 rounded-lg text-sm font-medium hover:bg-blue-100 transition-colors"
                         >
                             試算実行 & 検証
                         </button>

                         {isSimulationValid && !balanceError && (
                             <div className="flex items-center gap-2 text-xs text-emerald-600 bg-emerald-50 p-2 rounded border border-emerald-100 animate-in fade-in">
                                 <CheckCircle2 className="w-3 h-3" />
                                 検証OK: 実行可能です
                             </div>
                         )}
                         {balanceError && (
                             <div className="flex items-start gap-2 text-xs text-red-600 bg-red-50 p-2 rounded border border-red-100 animate-in fade-in">
                                 <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                                 {balanceError}
                             </div>
                         )}
                     </div>
                </div>

                {/* Load Scenario Card */}
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
                    <h4 className="text-sm font-bold text-slate-700 mb-3">設定読み込み</h4>
                    <div className="flex gap-2">
                        <select 
                            value={selectedLoadScenario}
                            onChange={(e) => setSelectedLoadScenario(e.target.value)}
                            className="flex-1 text-xs p-2 bg-slate-50 border border-slate-200 rounded-lg outline-none"
                        >
                            <option value="">保存済みシナリオを選択...</option>
                            {scenarios.map(s => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                        </select>
                        <button 
                            onClick={handleLoadScenario}
                            disabled={!selectedLoadScenario}
                            className="px-3 py-2 bg-slate-100 text-slate-600 rounded-lg text-xs hover:bg-slate-200 disabled:opacity-50"
                        >
                            読込
                        </button>
                    </div>
                </div>

                {/* Execution Card */}
                <div className="bg-slate-800 rounded-xl shadow-lg border border-slate-700 p-5 text-white">
                    <h4 className="text-sm font-bold text-slate-300 mb-4">実験実行コントロール</h4>
                    
                    <div className="space-y-4">
                        {/* Save Input */}
                        <div>
                            <label className="text-xs text-slate-400 block mb-1">シナリオ名 (保存用)</label>
                            <div className="flex gap-2">
                                <input 
                                    type="text" 
                                    value={scenarioNameInput}
                                    onChange={(e) => setScenarioNameInput(e.target.value)}
                                    placeholder="Scenario Name"
                                    className="flex-1 bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500"
                                />
                                <button 
                                    onClick={handleSave}
                                    className="p-2 bg-slate-700 hover:bg-slate-600 rounded border border-slate-600 transition-colors"
                                    title="設定を保存"
                                >
                                    <Save className="w-4 h-4" />
                                </button>
                            </div>
                        </div>

                        {/* Fail Toggle */}
                        <div className="flex items-center justify-between bg-slate-900/50 p-2 rounded border border-slate-700">
                            <span className="text-xs text-slate-400 flex items-center gap-2">
                                <AlertTriangle className="w-3 h-3" />
                                障害シミュレーション
                            </span>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input type="checkbox" checked={shouldFail} onChange={() => setShouldFail(!shouldFail)} className="sr-only peer" />
                                <div className="w-9 h-5 bg-slate-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-red-500"></div>
                            </label>
                        </div>

                        <button 
                            onClick={handleRun}
                            disabled={!isSimulationValid || activeExperiment.isRunning}
                            className={`w-full py-3 rounded-lg font-bold shadow-lg flex items-center justify-center gap-2 transition-all ${
                                !isSimulationValid || activeExperiment.isRunning
                                ? 'bg-slate-600 text-slate-400 cursor-not-allowed'
                                : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-blue-900/30'
                            }`}
                        >
                            {activeExperiment.isRunning ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    実行中...
                                </>
                            ) : (
                                <>
                                    <Play className="w-4 h-4 fill-current" />
                                    実験開始 (Run)
                                </>
                            )}
                        </button>
                    </div>
                </div>

            </div>
        </div>
    </div>
  );
};

export default ExperimentLayer;
