import React, { useState, useRef, useEffect } from 'react';
import { AllocatorStrategy, TransmitterStrategy, ExperimentConfig, UserAccount, ExperimentPreset, ExperimentScenario, ExperimentResult } from '../types';
import { Settings2, Box, Upload, Zap, List, CheckCircle2, AlertCircle, PlayCircle, Save, RotateCcw, Loader2, X, ChevronDown, FolderOpen, FileCode, Info, ChevronUp, Lock, ArrowLeft, Bookmark, CheckCircle, Folder, Clock, Database, Puzzle } from 'lucide-react';
import { Card, Modal, LogViewer, Badge } from '../components/Shared';
import { useResizerPanel, useFileUploadTree, useScenarioExecution } from '../hooks';

interface ExperimentLayerProps {
    users: UserAccount[];
    presets: ExperimentPreset[]; 
    deployedNodeCount: number;
    onRegisterResult: (result: ExperimentResult) => void;
    onSavePreset: (name: string, config: ExperimentConfig, generatorState?: any) => void;
    onDeletePreset?: (id: string) => void;
    notify: (type: 'success' | 'error', title: string, message: string) => void;
}

// --- Internal Components ---

// 戦略バッジ用ヘルパー
const getStrategyBadge = (type: 'allocator' | 'transmitter', value: string) => {
    let label = value;
    let colorClass = "bg-slate-100 text-slate-600";
    
    if (type === 'allocator') {
        colorClass = "bg-blue-50 text-blue-700 border border-blue-100";
        if (value === AllocatorStrategy.ROUND_ROBIN) label = "RR";
        else if (value === AllocatorStrategy.AVAILABLE) label = "LB"; // Load Balance
        else if (value === AllocatorStrategy.RANDOM) label = "RND";
        else if (value === AllocatorStrategy.STATIC) label = "FIX";
        else if (value === AllocatorStrategy.HASH) label = "HASH";
    } else {
        colorClass = "bg-purple-50 text-purple-700 border border-purple-100";
        if (value === TransmitterStrategy.ONE_BY_ONE) label = "1by1";
        else if (value === TransmitterStrategy.MULTI_BURST) label = "Push";
    }

    return (
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded flex items-center justify-center ${colorClass}`}>
            {label}
        </span>
    );
};

const RangeInput: React.FC<{
    label: string;
    type: 'data-size' | 'chunk-size';
    fixedValue: number;
    rangeParams: { start: number, end: number, step: number };
    isRange: boolean;
    disabled?: boolean;
    unit: string;
    onChangeFixed: (v: number) => void;
    onChangeRange: (k: 'start' | 'end' | 'step', v: number) => void;
    onToggleRange: () => void;
}> = ({ label, type, fixedValue, rangeParams, isRange, disabled, unit, onChangeFixed, onChangeRange, onToggleRange }) => (
    <div className={`bg-gray-50 p-5 rounded-2xl border transition-colors hover:border-primary-indigo/30 ${disabled ? 'border-orange-200 bg-orange-50' : 'border-gray-200'}`}>
        <div className="flex items-center justify-between mb-4">
            <label className="font-bold text-gray-700 text-base">{label} ({unit})</label>
            <label className={`inline-flex items-center text-xs cursor-pointer bg-white px-2 py-1 rounded border border-gray-200 shadow-sm ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
                <input type="checkbox" checked={isRange} onChange={onToggleRange} disabled={disabled} className="rounded text-primary-indigo focus:ring-0 w-3 h-3 mr-1" />
                <span className="text-gray-500 font-medium">範囲指定</span>
            </label>
        </div>
        
        {!isRange ? (
            <div>
                <input 
                    type="number" 
                    value={fixedValue} 
                    disabled={disabled}
                    onChange={(e) => onChangeFixed(Number(e.target.value))}
                    className="param-input block w-full rounded-lg border-gray-200 border p-2.5 focus:border-primary-indigo outline-none text-right font-mono text-lg font-bold disabled:bg-gray-100 disabled:text-gray-400"
                />
            </div>
        ) : (
            <div className="grid grid-cols-3 gap-2">
                {(['start', 'end', 'step'] as const).map(field => (
                    <input 
                        key={field}
                        type="number" 
                        placeholder={field.charAt(0).toUpperCase() + field.slice(1)}
                        value={rangeParams[field]}
                        onChange={(e) => onChangeRange(field, Number(e.target.value))}
                        className="param-input border border-gray-200 rounded-lg p-2 text-sm font-mono text-right focus:border-primary-indigo outline-none"
                    />
                ))}
            </div>
        )}
        {disabled && <p className="text-xs text-orange-500 mt-2 font-bold flex items-center justify-end"><Lock className="w-3 h-3 mr-1" />アップロード時は固定されます</p>}
    </div>
);

const StrategyCard: React.FC<{
    label: string;
    description: string;
    selected: boolean;
    onClick: () => void;
}> = ({ label, description, selected, onClick }) => (
    <div 
        onClick={onClick}
        className={`rounded-2xl p-5 relative bg-white cursor-pointer border-2 transition-all duration-200 ${selected ? 'border-primary-indigo bg-indigo-50/30' : 'border-gray-200 hover:border-indigo-200'}`}
    >
        <div className="flex justify-between items-start">
            <div>
                <div className="font-bold text-gray-800 text-base">{label}</div>
                <div className="text-xs font-medium text-gray-400 mt-1">{description}</div>
            </div>
            {selected && <div className="text-primary-indigo"><CheckCircle2 className="w-6 h-6 fill-current" /></div>}
        </div>
    </div>
);

const ExperimentLayer: React.FC<ExperimentLayerProps> = ({ users, presets, deployedNodeCount, onRegisterResult, onSavePreset, onDeletePreset, notify }) => {
  // --- State Definition ---
  const [mode, setMode] = useState<'virtual' | 'upload'>('virtual');
  
  // Sidebar State (Preset Panel)
  const [isPresetPanelOpen, setIsPresetPanelOpen] = useState(false);
  const [newPresetName, setNewPresetName] = useState("");

  // Resizable Panel Hook
  const { isOpen: isResultsPanelOpen, setIsOpen: setIsResultsPanelOpen, height: panelHeight, panelRef, resizerRef } = useResizerPanel(320, 100, 0.8);
  
  // Basic Settings
  const [projectName, setProjectName] = useState("複合パラメータテスト");
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [isAccountDropdownOpen, setIsAccountDropdownOpen] = useState(false);

  // Numeric Parameters
  const [dataSizeParams, setDataSizeParams] = useState({ 
      mode: 'fixed' as 'fixed'|'range', 
      fixed: 500, 
      range: { start: 100, end: 500, step: 100 } 
  });
  const [chunkSizeParams, setChunkSizeParams] = useState({ 
      mode: 'fixed' as 'fixed'|'range', 
      fixed: 64, 
      range: { start: 32, end: 128, step: 32 } 
  });
  
  // Chain Selection
  const [selectedChains, setSelectedChains] = useState<Set<string>>(new Set());
  const [isChainDropdownOpen, setIsChainDropdownOpen] = useState(false);
  
  // Strategies
  const [selectedAllocators, setSelectedAllocators] = useState<Set<AllocatorStrategy>>(new Set([AllocatorStrategy.ROUND_ROBIN]));
  const [selectedTransmitters, setSelectedTransmitters] = useState<Set<TransmitterStrategy>>(new Set([TransmitterStrategy.ONE_BY_ONE]));

  // File Upload Hook
  const { uploadStats, setUploadStats, fileInputRef, processFiles } = useFileUploadTree(notify);
  
  // Handle file process with state update for fixed data size
  const handleFileProcess = async (files: File[]) => {
      const sizeMB = await processFiles(files);
      setDataSizeParams(prev => ({ ...prev, mode: 'fixed', fixed: sizeMB }));
  };

  // Scenario Execution Hook
  const { scenarios, isGenerating, isExecutionRunning, generateScenarios, executeScenarios, reprocessCondition, handleRecalculateAll } = useScenarioExecution(notify, onRegisterResult);

  const handleGenerateClick = () => {
      generateScenarios({
          projectName,
          users,
          selectedUserId,
          mode,
          dataSizeParams,
          chunkSizeParams,
          selectedAllocators,
          selectedTransmitters,
          selectedChains,
          setIsOpen: setIsResultsPanelOpen
      });
  };

  // Modals
  const [errorModal, setErrorModal] = useState<{isOpen: boolean, id: string, reason: string}>({isOpen: false, id: '', reason: ''});
  const [logModal, setLogModal] = useState<{isOpen: boolean, scenario: ExperimentScenario | null}>({isOpen: false, scenario: null});

  // --- Initial Setup & Effects ---
  useEffect(() => {
      if (deployedNodeCount > 0 && selectedChains.size === 0) {
          const all = new Set<string>();
          for(let i=0; i<deployedNodeCount; i++) all.add(`datachain-${i}`);
          setSelectedChains(all);
      }
      if (users.length > 0 && !selectedUserId) setSelectedUserId(users[0].id);
  }, [deployedNodeCount, users]);

  // Render Tree
  const renderTreeNodes = (node: any) => (
      <div className="pl-4 border-l-2 border-gray-100 mb-2">
          {node.name !== 'root' && node.type === 'folder' && (
               <div className="flex items-center p-3 rounded-xl hover:bg-yellow-50 transition-colors cursor-default group mb-2">
                   <div className="w-10 h-10 rounded-full bg-yellow-50 flex items-center justify-center text-yellow-500 mr-4 shrink-0 group-hover:bg-yellow-100 transition-colors"><FolderOpen className="w-5 h-5" /></div>
                   <span className="text-base font-bold text-gray-700 group-hover:text-yellow-700 transition-colors">{node.name}</span>
               </div>
          )}
          {node.type === 'file' && (
              <div className="group flex items-center justify-between p-3 mb-1 rounded-xl hover:bg-indigo-50 transition-colors cursor-default">
                   <div className="flex items-center overflow-hidden min-w-0">
                       <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center text-blue-500 mr-4 shrink-0 group-hover:bg-blue-100 transition-colors"><FileCode className="w-5 h-5" /></div>
                       <span className="text-base font-bold text-gray-700 truncate group-hover:text-primary-indigo transition-colors">{node.name}</span>
                   </div>
                   <Badge>{(node.size/1024).toFixed(1)} KB</Badge>
              </div>
          )}
          <div className="pl-2">{Object.values(node.children || {}).map((child: any, i) => <div key={i}>{renderTreeNodes(child)}</div>)}</div>
      </div>
  );

  // --- Preset Handlers ---
  const handleSave = () => {
      if (!newPresetName) { notify('error', 'エラー', 'プリセット名を入力してください'); return; }
      const config: ExperimentConfig = {
          allocator: Array.from(selectedAllocators)[0], 
          transmitter: Array.from(selectedTransmitters)[0], 
          targetChains: Array.from(selectedChains),
          uploadType: mode === 'virtual' ? 'Virtual' : 'Real', 
          projectName, 
          userId: selectedUserId, 
          virtualConfig: { sizeMB: dataSizeParams.fixed, chunkSizeKB: chunkSizeParams.fixed, files: 1 }
      };
      const generatorState = { 
          projectName, 
          accountValue: selectedUserId, 
          dataSize: {
              mode: dataSizeParams.mode,
              fixed: dataSizeParams.fixed,
              start: dataSizeParams.range.start,
              end: dataSizeParams.range.end,
              step: dataSizeParams.range.step
          }, 
          chunkSize: {
              mode: chunkSizeParams.mode,
              fixed: chunkSizeParams.fixed,
              start: chunkSizeParams.range.start,
              end: chunkSizeParams.range.end,
              step: chunkSizeParams.range.step
          }, 
          allocators: Array.from(selectedAllocators), 
          transmitters: Array.from(selectedTransmitters), 
          selectedChains: Array.from(selectedChains), 
          uploadType: mode === 'virtual' ? 'Virtual' : 'Real' 
      };
      
      onSavePreset(newPresetName, config, generatorState);
      setNewPresetName("");
  };

  const loadPreset = (s: ExperimentPreset) => {
      if (s.generatorState) {
          const gs = s.generatorState; 
          setProjectName(gs.projectName); 
          setSelectedUserId(gs.accountValue); 
          setDataSizeParams({
              mode: gs.dataSize.mode,
              fixed: gs.dataSize.fixed,
              range: { start: gs.dataSize.start, end: gs.dataSize.end, step: gs.dataSize.step }
          }); 
          setChunkSizeParams({
              mode: gs.chunkSize.mode,
              fixed: gs.chunkSize.fixed,
              range: { start: gs.chunkSize.start, end: gs.chunkSize.end, step: gs.chunkSize.step }
          });
          setSelectedAllocators(new Set(gs.allocators as AllocatorStrategy[])); 
          setSelectedTransmitters(new Set(gs.transmitters as TransmitterStrategy[]));
          setSelectedChains(new Set(gs.selectedChains.filter((c:string) => !isNaN(parseInt(c.split('-')[1])) && parseInt(c.split('-')[1]) < deployedNodeCount)));
          setMode(gs.uploadType === 'Virtual' ? 'virtual' : 'upload');
      }
      notify('success', 'ロード完了', `プリセット "${s.name}" を読み込みました`);
  };

  // --- Render Helpers ---
  const selectedUser = users.find(u => u.id === selectedUserId);
  const successCount = scenarios.filter(c => ['READY', 'RUNNING', 'COMPLETE'].includes(c.status)).length;
  const failCount = scenarios.filter(c => ['FAIL'].includes(c.status)).length;
  const totalCost = scenarios.reduce((acc, cur) => acc + (cur.cost || 0), 0).toFixed(2);

  return (
    <div className="flex h-full w-full overflow-hidden relative text-gray-800">
        {/* Flex Container for Main Content and Sidebar */}
        <div className="flex w-full h-full relative">
            
            {/* Main Content Area */}
            <div className="flex-1 flex flex-col h-full min-w-0 relative z-10">
                <div className="flex-1 overflow-y-auto p-4 sm:p-6 custom-scrollbar">
                    <div className="space-y-6">
                        
                        {/* Section 1: Basic Settings */}
                        <Card className="overflow-hidden rounded-3xl shadow-soft border-gray-100">
                            <div className="bg-white px-6 py-5 border-b border-gray-100 flex justify-between items-center">
                                <h2 className="text-xl font-bold text-gray-800 flex items-center tracking-tight">
                                    <div className="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center mr-3 text-primary-indigo">
                                        <Settings2 className="w-5 h-5" />
                                    </div>
                                    基本設定
                                </h2>
                                <div className="bg-gray-100 p-1.5 rounded-xl flex text-sm font-bold">
                                    <button onClick={() => setMode('virtual')} className={`px-5 py-2 rounded-lg transition-all flex items-center gap-2 ${mode === 'virtual' ? 'bg-white shadow-sm text-primary-indigo' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200/50'}`}>
                                        <Box className="w-4 h-4" /> 仮想データ
                                    </button>
                                    <button onClick={() => setMode('upload')} className={`px-5 py-2 rounded-lg transition-all flex items-center gap-2 ${mode === 'upload' ? 'bg-white shadow-sm text-primary-indigo' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200/50'}`}>
                                        <Upload className="w-4 h-4" /> アップロード
                                    </button>
                                </div>
                            </div>
                            
                            <div className="p-6">
                                {mode === 'virtual' ? (
                                    <div className="flex items-start bg-blue-50 p-6 rounded-2xl border border-blue-100 animate-fade-in">
                                        <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 mr-4 shrink-0">
                                            <Info className="w-6 h-6" />
                                        </div>
                                        <div>
                                            <h3 className="text-lg font-bold text-blue-900 mb-1">仮想データ生成モード</h3>
                                            <p className="text-base text-blue-700 leading-relaxed opacity-90">ランダムなバイナリデータを動的に生成して実験を行います。物理的なファイルの準備は不要です。</p>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="animate-fade-in">
                                        <div 
                                            className={`upload-area rounded-3xl h-48 flex flex-col items-center justify-center cursor-pointer mb-6 group relative transition-all hover:bg-indigo-50/30 ${uploadStats.count > 0 ? 'border-primary-indigo' : ''}`} 
                                            onClick={() => fileInputRef.current?.click()} 
                                            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.add('drag-active'); }} 
                                            onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('drag-active'); }} 
                                            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('drag-active'); if(e.dataTransfer.files) handleFileProcess(Array.from(e.dataTransfer.files)); }}
                                        >
                                            <input type="file" ref={fileInputRef} className="hidden" multiple onChange={e => e.target.files && handleFileProcess(Array.from(e.target.files))} {...({webkitdirectory: ""} as any)} />
                                            <div className="bg-white w-20 h-20 rounded-full shadow-lg mb-4 flex items-center justify-center text-primary-indigo group-hover:scale-110 transition-transform duration-300">
                                                <Upload className="w-8 h-8" />
                                            </div>
                                            <p className="text-xl font-bold text-gray-700 pointer-events-none">フォルダまたはファイルをドロップ</p>
                                            <p className="text-sm text-gray-400 mt-2 pointer-events-none font-medium">※Zipファイルは自動で展開されます</p>
                                        </div>

                                        {uploadStats.tree && (
                                            <div className="bg-white rounded-3xl border border-gray-100 shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden ring-4 ring-gray-50 transition-all duration-300">
                                                <div 
                                                    className="px-6 py-4 border-b border-gray-100 flex justify-between items-center bg-white/80 backdrop-blur cursor-pointer hover:bg-gray-50 transition-colors" 
                                                    onClick={() => setUploadStats(p => ({...p, treeOpen: !p.treeOpen}))}
                                                >
                                                    <div className="flex items-center">
                                                        <div className="w-2 h-6 bg-primary-indigo rounded-full mr-3"></div>
                                                        <span className="text-lg font-bold text-gray-700">解析されたディレクトリ構造</span>
                                                    </div>
                                                    <div className="flex items-center space-x-4">
                                                        <span className="text-sm font-bold bg-indigo-50 text-indigo-600 px-4 py-1.5 rounded-full border border-indigo-100">
                                                            {uploadStats.count} Files, {uploadStats.sizeMB} MB
                                                        </span>
                                                        <ChevronUp className={`w-5 h-5 text-gray-400 transition-transform duration-300 ${uploadStats.treeOpen ? '' : 'rotate-180'}`} />
                                                    </div>
                                                </div>
                                                <div className={`transition-max-height duration-300 ease-in-out overflow-hidden ${uploadStats.treeOpen ? 'max-h-80' : 'max-h-0'}`}>
                                                    <div className="p-4 font-sans overflow-y-auto max-h-80 custom-scrollbar">
                                                        {renderTreeNodes(uploadStats.tree)}
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </Card>

                        {/* Section 2: Parameters */}
                        <Card className="rounded-3xl shadow-soft border-gray-100">
                            <div className="bg-white px-6 py-5 border-b border-gray-100">
                                <h2 className="text-xl font-bold text-gray-800 flex items-center tracking-tight">
                                    <div className="w-10 h-10 rounded-full bg-green-50 flex items-center justify-center mr-3 text-primary-green">
                                        <Zap className="w-5 h-5" />
                                    </div>
                                    実験シナリオパラメータ
                                </h2>
                            </div>
                            <div className="p-6 space-y-8">
                                {/* Project & Account */}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div>
                                        <label className="block text-base font-bold text-gray-700 mb-2 ml-1">プロジェクト名</label>
                                        <input type="text" value={projectName} onChange={e => setProjectName(e.target.value)} className="block w-full rounded-xl border-gray-200 bg-gray-50 p-3.5 focus:ring-2 focus:ring-primary-indigo focus:bg-white outline-none transition-all text-base font-medium shadow-sm" />
                                    </div>
                                    <div className="relative">
                                        <label className="block text-base font-bold text-gray-700 mb-2 ml-1">実行アカウント</label>
                                        <div 
                                            onClick={() => setIsAccountDropdownOpen(!isAccountDropdownOpen)} 
                                            className="block w-full rounded-xl border border-gray-200 bg-white p-3.5 pr-8 cursor-pointer relative shadow-sm hover:border-primary-indigo transition-colors"
                                        >
                                            <span className="block truncate text-gray-700 font-medium">
                                                {selectedUser ? `${selectedUser.name} (${selectedUser.balance.toFixed(2)} TKN)` : 'アカウントを選択...'}
                                            </span>
                                            <div className="absolute inset-y-0 right-0 flex items-center px-3 pointer-events-none text-gray-400">
                                                <ChevronDown className="w-4 h-4" />
                                            </div>
                                        </div>
                                        {isAccountDropdownOpen && (
                                            <div className="absolute top-full left-0 right-0 mt-2 bg-white border border-gray-200 rounded-xl shadow-xl z-20 max-h-60 overflow-y-auto">
                                                {users.map(u => (
                                                    <div 
                                                        key={u.id} 
                                                        onClick={() => { setSelectedUserId(u.id); setIsAccountDropdownOpen(false); }} 
                                                        className={`px-4 py-3 cursor-pointer transition-colors hover:bg-gray-50 ${selectedUserId === u.id ? 'bg-indigo-50 text-primary-indigo' : ''}`}
                                                    >
                                                        <div className="font-bold text-gray-800">{u.name}</div>
                                                        <div className="text-xs font-mono text-gray-500 mt-0.5">{u.balance.toFixed(2)} TKN</div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <hr className="border-gray-100" />
                                
                                {/* Numeric Parameters */}
                                <div>
                                    <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-5 flex items-center ml-1"><div className="w-1 h-4 bg-gray-300 mr-2 rounded-full"></div> 数値設定</h3>
                                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                                        <RangeInput 
                                            label="データサイズ"
                                            type="data-size"
                                            unit="MB"
                                            fixedValue={dataSizeParams.fixed}
                                            rangeParams={dataSizeParams.range}
                                            isRange={dataSizeParams.mode === 'range'}
                                            disabled={mode === 'upload'}
                                            onChangeFixed={(v) => setDataSizeParams(p => ({...p, fixed: v}))}
                                            onChangeRange={(k, v) => setDataSizeParams(p => ({...p, range: {...p.range, [k]: v}}))}
                                            onToggleRange={() => setDataSizeParams(p => ({...p, mode: p.mode === 'fixed' ? 'range' : 'fixed'}))}
                                        />
                                        <RangeInput 
                                            label="チャンクサイズ"
                                            type="chunk-size"
                                            unit="KB"
                                            fixedValue={chunkSizeParams.fixed}
                                            rangeParams={chunkSizeParams.range}
                                            isRange={chunkSizeParams.mode === 'range'}
                                            onChangeFixed={(v) => setChunkSizeParams(p => ({...p, fixed: v}))}
                                            onChangeRange={(k, v) => setChunkSizeParams(p => ({...p, range: {...p.range, [k]: v}}))}
                                            onToggleRange={() => setChunkSizeParams(p => ({...p, mode: p.mode === 'fixed' ? 'range' : 'fixed'}))}
                                        />
                                        {/* Datachain Selection */}
                                        <div className="bg-gray-50 p-5 rounded-2xl border border-gray-200 transition-colors hover:border-primary-indigo/30">
                                            <div className="flex items-center justify-between mb-4">
                                                <label className="font-bold text-gray-700 text-base">Datachain</label>
                                                <span className="text-xs bg-primary-indigo text-white px-2 py-0.5 rounded-full font-bold shadow-sm">{selectedChains.size}</span>
                                            </div>
                                            <div className="relative">
                                                <button onClick={() => setIsChainDropdownOpen(!isChainDropdownOpen)} className="w-full text-left bg-white border border-gray-200 rounded-lg p-2.5 text-sm flex justify-between items-center hover:bg-gray-50 shadow-sm">
                                                    <span className="text-gray-600 font-medium">チェーンを選択...</span>
                                                    <ChevronDown className="w-4 h-4" />
                                                </button>
                                                {isChainDropdownOpen && (
                                                    <div className="absolute left-0 right-0 mt-2 bg-white border border-gray-100 ring-1 ring-black/5 rounded-xl shadow-xl z-20 p-3">
                                                        <div className="flex justify-end space-x-3 mb-3 border-b border-gray-100 pb-2">
                                                            <button onClick={() => { 
                                                                const all = new Set<string>();
                                                                for(let i=0; i<deployedNodeCount; i++) all.add(`datachain-${i}`);
                                                                setSelectedChains(all);
                                                            }} className="text-xs font-bold text-primary-indigo hover:bg-indigo-50 px-2 py-1 rounded">All</button>
                                                            <button onClick={() => setSelectedChains(new Set())} className="text-xs font-bold text-gray-500 hover:bg-gray-100 px-2 py-1 rounded">None</button>
                                                        </div>
                                                        <div className="space-y-1.5 max-h-40 overflow-y-auto custom-scrollbar">
                                                            {Array.from({length: deployedNodeCount}).map((_, i) => {
                                                                const id = `datachain-${i}`;
                                                                return (
                                                                    <label key={id} className="flex items-center justify-between p-2 hover:bg-gray-50 rounded-lg cursor-pointer">
                                                                        <div className="flex items-center">
                                                                            <input 
                                                                                type="checkbox" 
                                                                                checked={selectedChains.has(id)} 
                                                                                onChange={() => {
                                                                                    const next = new Set(selectedChains);
                                                                                    next.has(id) ? next.delete(id) : next.add(id);
                                                                                    setSelectedChains(next);
                                                                                }}
                                                                                className="rounded text-primary-indigo w-4 h-4 focus:ring-0"
                                                                            />
                                                                            <span className="ml-3 text-sm font-bold text-gray-700">{id}</span>
                                                                        </div>
                                                                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700">Active</span>
                                                                    </label>
                                                                )
                                                            })}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Strategies */}
                                <div>
                                    <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-5 flex items-center ml-1"><div className="w-1 h-4 bg-gray-300 mr-2 rounded-full"></div> 配布・送信戦略</h3>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                        <div>
                                            <label className="block text-sm font-bold text-gray-500 mb-3 uppercase tracking-wide ml-1">Allocator Strategy</label>
                                            <div className="space-y-4">
                                                <StrategyCard label="Round Robin" description="分散アルゴリズム" selected={selectedAllocators.has(AllocatorStrategy.ROUND_ROBIN)} onClick={() => { const s=new Set(selectedAllocators); s.has(AllocatorStrategy.ROUND_ROBIN) && s.size>1 ? s.delete(AllocatorStrategy.ROUND_ROBIN) : s.add(AllocatorStrategy.ROUND_ROBIN); setSelectedAllocators(s); }} />
                                                <StrategyCard label="Available" description="空き容量ベース" selected={selectedAllocators.has(AllocatorStrategy.AVAILABLE)} onClick={() => { const s=new Set(selectedAllocators); s.has(AllocatorStrategy.AVAILABLE) && s.size>1 ? s.delete(AllocatorStrategy.AVAILABLE) : s.add(AllocatorStrategy.AVAILABLE); setSelectedAllocators(s); }} />
                                                <StrategyCard label="Random" description="ランダム分散" selected={selectedAllocators.has(AllocatorStrategy.RANDOM)} onClick={() => { const s=new Set(selectedAllocators); s.has(AllocatorStrategy.RANDOM) && s.size>1 ? s.delete(AllocatorStrategy.RANDOM) : s.add(AllocatorStrategy.RANDOM); setSelectedAllocators(s); }} />
                                            </div>
                                        </div>
                                        <div>
                                            <label className="block text-sm font-bold text-gray-500 mb-3 uppercase tracking-wide ml-1">Transmitter Strategy</label>
                                            <div className="space-y-4">
                                                <StrategyCard label="One By One" description="1つずつ順次送信" selected={selectedTransmitters.has(TransmitterStrategy.ONE_BY_ONE)} onClick={() => { const s=new Set(selectedTransmitters); s.has(TransmitterStrategy.ONE_BY_ONE) && s.size>1 ? s.delete(TransmitterStrategy.ONE_BY_ONE) : s.add(TransmitterStrategy.ONE_BY_ONE); setSelectedTransmitters(s); }} />
                                                <StrategyCard label="Multi Burst" description="並列バースト送信" selected={selectedTransmitters.has(TransmitterStrategy.MULTI_BURST)} onClick={() => { const s=new Set(selectedTransmitters); s.has(TransmitterStrategy.MULTI_BURST) && s.size>1 ? s.delete(TransmitterStrategy.MULTI_BURST) : s.add(TransmitterStrategy.MULTI_BURST); setSelectedTransmitters(s); }} />
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <div className="pt-4 pb-2">
                                    <button onClick={handleGenerateClick} disabled={isGenerating} className="w-full bg-primary-green hover:bg-emerald-500 text-white font-bold py-4 px-8 rounded-2xl shadow-lg shadow-emerald-200 transition-all transform hover:-translate-y-1 active:translate-y-0 flex items-center justify-center text-xl tracking-wide disabled:opacity-50 disabled:cursor-not-allowed">
                                        {isGenerating ? <Loader2 className="w-6 h-6 animate-spin mr-3" /> : <Zap className="w-6 h-6 mr-3" />} シナリオを作成
                                    </button>
                                </div>
                            </div>
                        </Card>

                        {/* Explicit Spacer to prevent bottom panel overlap */}
                        <div className="h-[50px] w-full pointer-events-none" aria-hidden="true" />
                    </div>
                </div>

                {/* Results Panel (Fixed Bottom) */}
                <div 
                    ref={panelRef}
                    className={`absolute bottom-0 left-0 right-0 bg-white shadow-[0_-10px_40px_rgba(0,0,0,0.1)] z-30 rounded-t-[2rem] border-t border-gray-100 flex flex-col bottom-panel-transition ${isResultsPanelOpen ? '' : 'h-20'}`} 
                    style={{ height: isResultsPanelOpen ? panelHeight : undefined }}
                >
                    {/* Resizer Handle */}
                    <div ref={resizerRef} className="absolute top-0 left-0 right-0 h-4 w-full cursor-row-resize z-50 group flex justify-center items-center">
                        <div className="w-16 h-1.5 bg-gray-200 rounded-full group-hover:bg-primary-indigo transition-colors"></div>
                    </div>

                    {/* Header */}
                    <div className="px-8 py-5 border-b border-gray-100 flex justify-between items-center bg-white rounded-t-[2rem] cursor-pointer hover:bg-gray-50 transition-colors relative z-40 mt-1" onClick={() => setIsResultsPanelOpen(!isResultsPanelOpen)}>
                        <div className="flex items-center">
                            <h2 className="text-xl font-bold text-gray-800 flex items-center tracking-tight">
                                <div className="w-8 h-8 rounded-full bg-indigo-50 flex items-center justify-center mr-3 text-primary-indigo">
                                    <List className="w-5 h-5" />
                                </div>
                                生成結果
                                <span className="ml-3 bg-primary-indigo text-white text-sm font-bold px-2.5 py-0.5 rounded-full shadow-sm shadow-indigo-200">{scenarios.length}</span>
                            </h2>
                            <div className="text-base text-gray-600 ml-8 font-medium hidden sm:block">
                                総コスト試算: <span className="font-mono font-bold text-gray-900 text-lg">{totalCost}</span> TKN
                            </div>
                        </div>
                        <div className="w-10 h-10 rounded-full bg-gray-50 flex items-center justify-center text-gray-400 group-hover:bg-white group-hover:shadow-sm transition-all">
                             <ChevronUp className={`w-5 h-5 transition-transform ${isResultsPanelOpen ? 'rotate-180' : ''}`} />
                        </div>
                    </div>

                    {/* Status Bar & Execute */}
                    <div className="px-8 py-3 bg-indigo-50/50 border-b border-indigo-50 flex items-center justify-between gap-4 shrink-0">
                        <div className="flex items-center space-x-8 text-sm">
                            <div className="flex items-center text-green-600 bg-green-50 px-3 py-1 rounded-full border border-green-100">
                                <CheckCircle className="w-5 h-5 mr-2" />
                                <span className="font-bold text-lg">{successCount}</span>
                                <span className="text-xs text-green-700 font-bold ml-1.5 uppercase">Success</span>
                            </div>
                            <div className="h-6 w-px bg-gray-300"></div>
                            <div className="flex items-center text-red-600 bg-red-50 px-3 py-1 rounded-full border border-red-100">
                                <AlertCircle className="w-5 h-5 mr-2" />
                                <span className="font-bold text-lg">{failCount}</span>
                                <span className="text-xs text-red-700 font-bold ml-1.5 uppercase">Fail</span>
                            </div>
                        </div>
                        <div className="flex gap-3">
                            {/* Bulk Recalculate Button */}
                            {failCount > 0 && (
                                <button 
                                    onClick={handleRecalculateAll}
                                    disabled={isExecutionRunning}
                                    className="bg-white border border-status-fail text-status-fail px-4 py-2.5 rounded-xl font-bold shadow-sm flex items-center hover:bg-red-50 transition-all"
                                >
                                    <RotateCcw className="w-5 h-5 mr-2" />
                                    一括再試算
                                </button>
                            )}
                            <button 
                                onClick={() => executeScenarios(projectName)} 
                                disabled={scenarios.length === 0 || isExecutionRunning || successCount === 0} 
                                className="bg-gray-300 text-white px-6 py-2.5 rounded-xl font-bold shadow-sm flex items-center disabled:opacity-50 data-[ready=true]:bg-primary-indigo data-[ready=true]:hover:bg-indigo-700 data-[ready=true]:hover:shadow-md transition-all transform active:scale-95" 
                                data-ready={successCount > 0 && !isExecutionRunning}
                            >
                                {isExecutionRunning ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <PlayCircle className="w-5 h-5 mr-2" />}
                                実行
                            </button>
                        </div>
                    </div>

                    {/* Scenario List */}
                    <div className="flex-1 overflow-y-auto p-6 space-y-3 bg-gray-50/50">
                        {scenarios.map(c => {
                            let border = 'border-l-4 border-gray-200';
                            let statusContent = null;
                            let bgClass = 'bg-white';

                            if (c.status === 'PENDING' || c.status === 'CALCULATING') {
                                border = 'border-l-4 border-status-process';
                                statusContent = <div className="text-status-process font-bold flex items-center"><Loader2 className="w-4 h-4 animate-spin mr-1.5" /> 試算中</div>;
                            } else if (c.status === 'RUNNING') {
                                border = 'border-l-4 border-status-process';
                                statusContent = <div className="text-status-process font-bold flex items-center"><Settings2 className="w-4 h-4 animate-spin mr-1.5" /> 実行中</div>;
                            } else if (c.status === 'READY') {
                                border = 'border-l-4 border-status-ready';
                                statusContent = <div className="text-status-ready font-bold flex items-center"><CheckCircle2 className="w-5 h-5 mr-1.5" /> {c.cost.toFixed(2)} TKN</div>;
                            } else if (c.status === 'COMPLETE') {
                                border = 'border-l-4 border-status-success';
                                statusContent = <div className="text-status-success font-bold flex items-center"><CheckCircle2 className="w-5 h-5 mr-1.5" /> 完了</div>;
                            } else if (c.status === 'FAIL') {
                                border = 'border-l-4 border-status-fail';
                                bgClass = 'bg-red-50/30';
                                statusContent = (
                                    <div className="flex items-center">
                                        <button onClick={(e) => { e.stopPropagation(); setErrorModal({isOpen: true, id: c.uniqueId, reason: c.failReason || ''}); }} className="text-status-fail font-bold hover:bg-red-100 px-3 py-1.5 rounded-lg transition-colors flex items-center">
                                            <AlertCircle className="w-5 h-5 mr-1.5" /> ERROR
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); reprocessCondition(c.id); }} className="ml-2 bg-white text-status-fail border border-status-fail hover:bg-red-100 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors shadow-sm flex items-center">
                                            <RotateCcw className="w-4 h-4 mr-1.5" /> 再試算
                                        </button>
                                    </div>
                                );
                            }

                            return (
                                <div key={c.uniqueId} onClick={() => setLogModal({isOpen: true, scenario: c})} className={`p-4 rounded-2xl shadow-sm ${border} ${bgClass} flex justify-between items-center animate-fade-in hover:shadow-md transition-all cursor-pointer mb-1`}>
                                    <div className="flex items-center space-x-5 flex-1">
                                        <div className="text-center w-10 shrink-0"><span className="text-[10px] font-bold text-gray-400 block uppercase tracking-wider">Seq</span><span className="font-black text-gray-700 text-lg">{c.id}</span></div>
                                        <div className="text-sm overflow-hidden">
                                            <div className="font-mono text-xs font-bold text-gray-400 truncate mb-1 opacity-70">{c.uniqueId}</div>
                                            <div className="font-bold text-gray-800 text-base">Size: {c.dataSize}MB / Chunk: {c.chunkSize}KB</div>
                                            <div className="text-gray-500 text-xs mt-1 font-medium flex gap-2">
                                                <span className="bg-gray-100 px-2 py-0.5 rounded text-gray-600">{c.allocator}</span>
                                                <span className="bg-gray-100 px-2 py-0.5 rounded text-gray-600">{c.transmitter}</span>
                                                <span className="text-gray-400">|</span>
                                                <span>Chains: {c.chains}</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="text-right shrink-0 flex items-center">{statusContent}</div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Sidebar Toggle Button */}
                <button onClick={() => setIsPresetPanelOpen(true)} className={`absolute top-4 right-0 bg-white border border-gray-200 shadow-lg rounded-l-xl p-3 text-scenario-accent hover:bg-orange-50 transition-all z-20 ${isPresetPanelOpen ? 'translate-x-full opacity-0 pointer-events-none' : 'translate-x-0'}`}>
                    <ArrowLeft className="w-5 h-5" />
                </button>
            </div>

            {/* Sidebar (Preset Panel) */}
            {/* No margin left/right gap, just flex width transition */}
            <div className={`flex-shrink-0 border-l border-gray-200 bg-white relative z-20 transition-all duration-300 overflow-hidden ${isPresetPanelOpen ? 'w-96' : 'w-0'}`}>
                <aside className="h-full flex flex-col w-96"> {/* Fixed inner width to prevent squashing content */}
                    {/* Header */}
                    <div className="p-5 border-b border-gray-100 flex justify-between items-center shrink-0">
                        <h2 className="font-bold text-gray-700 flex items-center text-lg">
                            <Bookmark className="w-6 h-6 mr-2 text-scenario-accent" />
                            プリセットパネル
                        </h2>
                        <button onClick={() => setIsPresetPanelOpen(false)} className="text-gray-400 hover:text-gray-600 p-2 rounded-lg hover:bg-gray-50 transition-colors">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Save Form */}
                    <div className="p-4 border-b border-gray-100 bg-gray-50/30 shrink-0">
                        <div className="flex gap-2">
                            <input type="text" value={newPresetName} onChange={e => setNewPresetName(e.target.value)} placeholder="設定名..." className="flex-1 border border-gray-200 bg-white rounded-xl px-4 py-2.5 text-sm focus:border-scenario-accent focus:ring-2 focus:ring-orange-100 outline-none transition-all font-medium" />
                            <button onClick={handleSave} className="bg-scenario-accent hover:bg-orange-600 text-white rounded-xl px-3.5 py-2.5 shadow-md shadow-orange-100 transition-colors flex items-center justify-center min-w-[44px]">
                                <Save className="w-5 h-5" />
                            </button>
                        </div>
                    </div>

                    {/* List */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar bg-gray-50">
                         {presets.length === 0 && (
                            <div className="text-center py-12">
                                <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4 text-gray-300">
                                    <Folder className="w-8 h-8" />
                                </div>
                                <p className="text-sm text-gray-400 font-medium">保存されたプリセットはありません</p>
                            </div>
                        )}
                        {presets.map(s => {
                            // Extract strategy values for badges
                            const allocator = s.generatorState ? s.generatorState.allocators[0] : s.config.allocator;
                            const transmitter = s.generatorState ? s.generatorState.transmitters[0] : s.config.transmitter;
                            const dataSizeLabel = s.generatorState ? (s.generatorState.dataSize.mode === 'range' ? `${s.generatorState.dataSize.start}MB` : `${s.generatorState.dataSize.fixed}MB`) : `${s.config.virtualConfig?.sizeMB}MB`;
                            const chunkLabel = s.generatorState ? (s.generatorState.chunkSize.mode === 'range' ? `Range` : `${s.generatorState.chunkSize.fixed}KB`) : `${s.config.virtualConfig?.chunkSizeKB}KB`;

                            return (
                                <div key={s.id} className="bg-white p-4 rounded-2xl border border-gray-200 shadow-sm hover:shadow-md transition-all group relative cursor-default">
                                    <div className="flex justify-between items-start mb-1">
                                        <h3 className="font-bold text-slate-800 text-lg truncate w-full pr-8" title={s.name}>{s.name}</h3>
                                        {onDeletePreset && (
                                            <button onClick={(e) => { e.stopPropagation(); onDeletePreset(s.id); }} className="text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-full p-1 absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-all">
                                                <X className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>
                                    
                                    <div className="flex items-center text-xs text-slate-400 mb-4 font-medium">
                                        <Clock className="w-3 h-3 mr-1" />{new Date(s.lastModified).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                    </div>
                                    
                                    <div className="flex items-center gap-2 mb-3">
                                        <Badge color="blue" className="flex items-center gap-1 bg-blue-50 text-blue-700 border-blue-100">
                                            <Database className="w-3 h-3"/>{dataSizeLabel}
                                        </Badge>
                                        <Badge color="slate" className="flex items-center gap-1 bg-purple-50 text-purple-700 border-purple-100">
                                            <Puzzle className="w-3 h-3"/>{chunkLabel}
                                        </Badge>
                                    </div>

                                    <div className="flex items-center gap-2 mb-4">
                                        {getStrategyBadge('allocator', allocator)}
                                        {getStrategyBadge('transmitter', transmitter)}
                                    </div>

                                    <button onClick={() => loadPreset(s)} className="w-full bg-white border border-scenario-accent text-scenario-accent text-sm font-bold py-2.5 rounded-xl hover:bg-scenario-accent hover:text-white transition-all flex items-center justify-center group/btn">
                                        <RotateCcw className="w-4 h-4 mr-2 group-hover/btn:rotate-180 transition-transform" /> 適用する
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </aside>
            </div>
        </div>

        {/* Error Modal */}
        <Modal isOpen={errorModal.isOpen} onClose={() => setErrorModal(p => ({...p, isOpen: false}))} className="max-w-md w-full p-8 rounded-3xl ring-4 ring-white/50">
            <div className="flex items-center border-b border-gray-100 pb-4 mb-6">
                <div className="bg-red-50 p-3 rounded-full mr-4 text-status-fail"><AlertCircle className="w-8 h-8" /></div>
                <h3 className="text-xl font-bold text-gray-800">試算エラー詳細</h3>
            </div>
            <div className="mb-8">
                <p className="text-xs font-mono text-gray-400 mb-2 uppercase tracking-wide">ID: {errorModal.id}</p>
                <p className="text-sm font-bold text-gray-400 mb-2 uppercase tracking-wide">Reason</p>
                <p className="text-red-600 font-medium bg-red-50 p-4 rounded-xl border border-red-100 text-base leading-relaxed shadow-sm">{errorModal.reason}</p>
            </div>
            <div className="flex justify-end">
                <button onClick={() => setErrorModal(p => ({...p, isOpen: false}))} className="px-6 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold rounded-xl transition-colors">閉じる</button>
            </div>
        </Modal>
        
        {/* Log Modal */}
        <Modal isOpen={logModal.isOpen} onClose={() => setLogModal(p => ({...p, isOpen: false}))} className="max-w-3xl w-full h-[75vh] flex flex-col p-0 rounded-3xl ring-4 ring-white/50">
             <div className="px-8 py-6 border-b border-gray-100 flex justify-between items-center bg-white rounded-t-3xl">
                <div className="flex items-center">
                    <div className="mr-4">
                        {logModal.scenario?.status === 'RUNNING' ? <Loader2 className="w-8 h-8 text-status-process animate-spin" /> :
                         logModal.scenario?.status === 'COMPLETE' ? <CheckCircle className="w-8 h-8 text-status-success" /> :
                         logModal.scenario?.status === 'FAIL' ? <AlertCircle className="w-8 h-8 text-status-fail" /> :
                         <Clock className="w-8 h-8 text-status-ready" />}
                    </div>
                    <div><h3 className="text-xl font-bold text-gray-800">実行詳細ログ</h3><p className="text-sm text-gray-400 font-mono mt-1 font-medium">{logModal.scenario?.uniqueId}</p></div>
                </div>
                <button onClick={() => setLogModal(p => ({...p, isOpen: false}))} className="w-10 h-10 rounded-full hover:bg-gray-100 flex items-center justify-center transition-colors text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
             </div>
             <div className="px-8 py-4 border-b border-gray-100 bg-gray-50/50">
                <div className="flex justify-between items-center text-sm mb-2">
                    <span className="font-bold text-gray-500">Progress</span>
                    <span className="font-bold text-primary-indigo text-lg">{logModal.scenario?.status === 'COMPLETE' ? '100' : logModal.scenario?.status === 'FAIL' ? '80' : logModal.scenario?.status === 'RUNNING' ? '45' : '0'}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                    <div className={`h-3 rounded-full transition-all duration-300 shadow-sm ${logModal.scenario?.status === 'FAIL' ? 'bg-status-fail' : 'bg-primary-indigo'}`} style={{width: logModal.scenario?.status === 'COMPLETE' ? '100%' : logModal.scenario?.status === 'FAIL' ? '80%' : '45%'}}></div>
                </div>
             </div>
             <LogViewer logs={logModal.scenario?.logs || []} className="flex-1 m-0 rounded-none border-x-0 bg-gray-900 font-mono text-sm text-gray-300 leading-relaxed" />
             <div className="px-8 py-5 border-t border-gray-100 bg-white flex justify-end rounded-b-3xl">
                <button onClick={() => setLogModal(p => ({...p, isOpen: false}))} className="px-6 py-2.5 bg-white border-2 border-gray-100 hover:border-gray-300 text-gray-600 font-bold rounded-xl transition-colors shadow-sm">閉じる</button>
             </div>
        </Modal>
    </div>
  );
};

export default ExperimentLayer;