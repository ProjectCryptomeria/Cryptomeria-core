import React, { useState, useMemo } from 'react';
import { ExperimentResult, SortConfig, FilterCondition, AllocatorStrategy, TransmitterStrategy } from '../types';
import { Download, Filter, Search, FileText, AlertTriangle, CheckCircle, Clock, X, Database, Server, Network, ChevronDown, ChevronUp, Badge } from 'lucide-react';

interface LibraryLayerProps {
    results: ExperimentResult[];
}

const LibraryLayer: React.FC<LibraryLayerProps> = ({ results }) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedResult, setSelectedResult] = useState<ExperimentResult | null>(null);
  
  // Sorting State
  const [sortConfig, setSortConfig] = useState<SortConfig>({ key: 'executedAt', direction: 'desc' });

  // Filtering State
  const [filters, setFilters] = useState<FilterCondition[]>([]);
  const [isFilterMenuOpen, setIsFilterMenuOpen] = useState(false);

  // --- Handlers ---

  const handleSort = (key: keyof ExperimentResult) => {
      setSortConfig(current => ({
          key,
          direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc'
      }));
  };

  const addFilter = (key: keyof ExperimentResult, value: string, labelPrefix: string) => {
      // Avoid duplicates
      if (filters.some(f => f.key === key && f.value === value)) return;
      setFilters([...filters, { key, value, label: `${labelPrefix}: ${value}` }]);
      setIsFilterMenuOpen(false);
  };

  const removeFilter = (index: number) => {
      setFilters(filters.filter((_, i) => i !== index));
  };

  // --- Filtering & Sorting Logic ---
  const processedResults = useMemo(() => {
      let data = [...results];

      // 1. Text Search
      if (searchTerm) {
          data = data.filter(r => 
              r.scenarioName.toLowerCase().includes(searchTerm.toLowerCase()) || 
              r.id.toLowerCase().includes(searchTerm.toLowerCase())
          );
      }

      // 2. Filters
      if (filters.length > 0) {
          data = data.filter(item => {
              return filters.every(cond => {
                  const itemValue = String(item[cond.key]);
                  return itemValue === cond.value;
              });
          });
      }

      // 3. Sort
      data.sort((a, b) => {
          const aValue = a[sortConfig.key];
          const bValue = b[sortConfig.key];

          if (aValue === undefined || bValue === undefined) return 0;

          if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
          if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
          return 0;
      });

      return data;
  }, [results, searchTerm, filters, sortConfig]);


  // Formatter helpers
  const fmtBytes = (mb: number) => `${mb.toLocaleString()} MB`;
  const fmtTime = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  const fmtSpeed = (bps: number) => `${(bps / 1024 / 1024).toFixed(2)} Mbps`;

  // Sort Icon Helper
  const SortIcon = ({ columnKey }: { columnKey: keyof ExperimentResult }) => {
      if (sortConfig.key !== columnKey) return <span className="w-4 h-4 opacity-0 group-hover:opacity-30 ml-1">↕</span>;
      return sortConfig.direction === 'asc' ? <ChevronUp className="w-4 h-4 ml-1" /> : <ChevronDown className="w-4 h-4 ml-1" />;
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 relative h-full flex flex-col">
        
        {/* Detail Modal */}
        {selectedResult && (
            <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="bg-white w-full max-w-3xl rounded-xl shadow-2xl border border-slate-200 flex flex-col max-h-[90vh] overflow-hidden animate-in zoom-in-95 duration-200">
                    <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
                        <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-full ${selectedResult.status === 'SUCCESS' ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'}`}>
                                {selectedResult.status === 'SUCCESS' ? <CheckCircle className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
                            </div>
                            <div>
                                <h3 className="font-bold text-lg text-slate-800">{selectedResult.scenarioName}</h3>
                                <div className="text-xs text-slate-500 font-mono">ID: {selectedResult.id}</div>
                            </div>
                        </div>
                        <button onClick={() => setSelectedResult(null)} className="text-slate-400 hover:text-slate-600">
                            <X className="w-6 h-6" />
                        </button>
                    </div>
                    
                    <div className="p-6 overflow-y-auto custom-scrollbar">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                            {/* Details Sections (Same as before) */}
                            <div className="space-y-4">
                                <h4 className="text-sm font-bold text-slate-400 uppercase tracking-wider border-b border-slate-100 pb-2">基本情報</h4>
                                <div className="grid grid-cols-2 gap-4 text-sm">
                                    <div>
                                        <div className="text-slate-500">実行日時</div>
                                        <div className="font-mono">{new Date(selectedResult.executedAt).toLocaleString('ja-JP')}</div>
                                    </div>
                                    <div>
                                        <div className="text-slate-500">ステータス</div>
                                        <div className={`font-bold ${selectedResult.status === 'SUCCESS' ? 'text-emerald-600' : 'text-red-600'}`}>{selectedResult.status}</div>
                                    </div>
                                </div>
                            </div>

                             {/* Section 2: Scenario Config */}
                             <div className="space-y-4">
                                <h4 className="text-sm font-bold text-slate-400 uppercase tracking-wider border-b border-slate-100 pb-2">シナリオ設定</h4>
                                <div className="space-y-2 text-sm">
                                    <div className="flex justify-between">
                                        <span className="text-slate-500 flex items-center gap-2"><Database className="w-3 h-3"/> データサイズ</span>
                                        <span className="font-mono">{fmtBytes(selectedResult.dataSizeMB)}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-500 flex items-center gap-2"><Network className="w-3 h-3"/> チャンクサイズ</span>
                                        <span className="font-mono">{selectedResult.chunkSizeKB} KB</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">総Tx数</span>
                                        <span className="font-mono">{selectedResult.totalTxCount.toLocaleString()}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">Allocator</span>
                                        <span>{selectedResult.allocator}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">Transmitter</span>
                                        <span>{selectedResult.transmitter}</span>
                                    </div>
                                </div>
                            </div>

                            {/* Section 3: Infrastructure Usage */}
                            <div className="space-y-4 md:col-span-2">
                                <h4 className="text-sm font-bold text-slate-400 uppercase tracking-wider border-b border-slate-100 pb-2">インフラ使用状況</h4>
                                <div className="text-sm mb-2">
                                    <span className="text-slate-500">使用したDataChain数: </span>
                                    <span className="font-bold text-slate-800">{selectedResult.targetChainCount}</span>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {selectedResult.usedChains.map(chain => (
                                        <span key={chain} className="px-2 py-1 bg-slate-100 text-slate-600 rounded border border-slate-200 text-xs font-mono flex items-center gap-1">
                                            <Server className="w-3 h-3" />
                                            {chain}
                                        </span>
                                    ))}
                                </div>
                            </div>

                            {/* Section 4: Performance */}
                            <div className="space-y-4 md:col-span-2 bg-slate-50 p-4 rounded-lg border border-slate-100">
                                <h4 className="text-sm font-bold text-slate-600 flex items-center gap-2">
                                    <Clock className="w-4 h-4 text-blue-500" />
                                    パフォーマンス指標
                                </h4>
                                <div className="grid grid-cols-3 gap-4 text-center">
                                    <div>
                                        <div className="text-xs text-slate-500 mb-1">アップロード時間</div>
                                        <div className="font-mono font-bold text-lg">{fmtTime(selectedResult.uploadTimeMs)}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-slate-500 mb-1">ダウンロード時間</div>
                                        <div className="font-mono font-bold text-lg">{fmtTime(selectedResult.downloadTimeMs)}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-slate-500 mb-1">スループット</div>
                                        <div className="font-mono font-bold text-lg text-blue-600">{fmtSpeed(selectedResult.throughputBps)}</div>
                                    </div>
                                </div>
                            </div>

                        </div>
                    </div>
                </div>
            </div>
        )}

        {/* Toolbar */}
        <div className="flex flex-col gap-4 bg-white p-4 rounded-xl shadow-sm border border-slate-200">
            <div className="flex flex-col md:flex-row justify-between gap-4">
                <div className="relative flex-1 max-w-md">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
                    <input 
                        type="text" 
                        placeholder="シナリオ名またはIDで検索..." 
                        className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>
                
                <div className="flex gap-2 relative">
                    <button 
                        onClick={() => setIsFilterMenuOpen(!isFilterMenuOpen)}
                        className={`flex items-center gap-2 px-4 py-2 bg-slate-50 border text-slate-600 rounded-lg text-sm hover:bg-slate-100 transition-colors ${isFilterMenuOpen ? 'border-blue-300 ring-2 ring-blue-100' : 'border-slate-200'}`}
                    >
                        <Filter className="w-4 h-4" />
                        フィルター追加
                    </button>
                    
                    {/* Filter Dropdown */}
                    {isFilterMenuOpen && (
                        <div className="absolute top-full right-0 mt-2 w-56 bg-white rounded-xl shadow-xl border border-slate-200 z-20 p-2 animate-in fade-in zoom-in-95 duration-100">
                            <div className="text-xs font-bold text-slate-400 uppercase px-2 py-1">ステータス</div>
                            {['SUCCESS', 'FAILED', 'ABORTED'].map(status => (
                                <button key={status} onClick={() => addFilter('status', status, 'Status')} className="w-full text-left px-2 py-1.5 text-sm hover:bg-slate-50 rounded flex items-center gap-2">
                                    {status === 'SUCCESS' ? <div className="w-2 h-2 bg-emerald-500 rounded-full"/> : <div className="w-2 h-2 bg-red-500 rounded-full"/>}
                                    {status}
                                </button>
                            ))}
                            <div className="border-t border-slate-100 my-1"></div>
                            
                            <div className="text-xs font-bold text-slate-400 uppercase px-2 py-1">アロケーター</div>
                            {Object.values(AllocatorStrategy).map(a => (
                                <button key={a} onClick={() => addFilter('allocator', a, 'Alloc')} className="w-full text-left px-2 py-1.5 text-sm hover:bg-slate-50 rounded">
                                    {a}
                                </button>
                            ))}
                            <div className="border-t border-slate-100 my-1"></div>
                            
                            <div className="text-xs font-bold text-slate-400 uppercase px-2 py-1">送信戦略</div>
                            {Object.values(TransmitterStrategy).map(t => (
                                <button key={t} onClick={() => addFilter('transmitter', t, 'Trans')} className="w-full text-left px-2 py-1.5 text-sm hover:bg-slate-50 rounded">
                                    {t}
                                </button>
                            ))}
                        </div>
                    )}

                    <button className="flex items-center gap-2 px-4 py-2 bg-blue-50 border border-blue-100 text-blue-600 rounded-lg text-sm font-medium hover:bg-blue-100 transition-colors">
                        <Download className="w-4 h-4" />
                        CSV出力
                    </button>
                </div>
            </div>

            {/* Active Filters (Badges) */}
            {filters.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
                    {filters.map((f, idx) => (
                        <span key={idx} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-medium border border-blue-100">
                            {f.label}
                            <button onClick={() => removeFilter(idx)} className="p-0.5 hover:bg-blue-200 rounded-full transition-colors">
                                <X className="w-3 h-3" />
                            </button>
                        </span>
                    ))}
                    <button onClick={() => setFilters([])} className="text-xs text-slate-400 hover:text-slate-600 underline">
                        すべてクリア
                    </button>
                </div>
            )}
        </div>

        {/* Results Table */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex-1 flex flex-col">
            <div className="overflow-auto flex-1">
                <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-slate-500 font-medium border-b border-slate-100 sticky top-0 z-10">
                        <tr>
                            <th className="px-6 py-3 cursor-pointer hover:bg-slate-100 group transition-colors" onClick={() => handleSort('executedAt')}>
                                <div className="flex items-center">実行ID / 日時 <SortIcon columnKey="executedAt" /></div>
                            </th>
                            <th className="px-6 py-3 cursor-pointer hover:bg-slate-100 group transition-colors" onClick={() => handleSort('scenarioName')}>
                                <div className="flex items-center">シナリオ名 <SortIcon columnKey="scenarioName" /></div>
                            </th>
                            <th className="px-6 py-3 cursor-pointer hover:bg-slate-100 group transition-colors" onClick={() => handleSort('status')}>
                                <div className="flex items-center">ステータス <SortIcon columnKey="status" /></div>
                            </th>
                            <th className="px-6 py-3 cursor-pointer hover:bg-slate-100 group transition-colors" onClick={() => handleSort('allocator')}>
                                <div className="flex items-center">戦略 <SortIcon columnKey="allocator" /></div>
                            </th>
                            <th className="px-6 py-3 text-right cursor-pointer hover:bg-slate-100 group transition-colors" onClick={() => handleSort('dataSizeMB')}>
                                <div className="flex items-center justify-end">データサイズ <SortIcon columnKey="dataSizeMB" /></div>
                            </th>
                            <th className="px-6 py-3 text-right cursor-pointer hover:bg-slate-100 group transition-colors" onClick={() => handleSort('throughputBps')}>
                                <div className="flex items-center justify-end">スループット <SortIcon columnKey="throughputBps" /></div>
                            </th>
                            <th className="px-6 py-3 text-right">詳細</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {processedResults.map(r => (
                            <tr key={r.id} className="group hover:bg-slate-50 transition-colors">
                                <td className="px-6 py-4">
                                    <div className="font-mono font-medium text-slate-700">{r.id}</div>
                                    <div className="text-xs text-slate-400 flex items-center gap-1 mt-0.5">
                                        <Clock className="w-3 h-3" />
                                        {new Date(r.executedAt).toLocaleString('ja-JP')}
                                    </div>
                                </td>
                                <td className="px-6 py-4 font-medium text-slate-800">{r.scenarioName}</td>
                                <td className="px-6 py-4">
                                    <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${
                                        r.status === 'SUCCESS' ? 'bg-emerald-100 text-emerald-700' :
                                        r.status === 'FAILED' ? 'bg-red-100 text-red-700' : 'bg-slate-200 text-slate-600'
                                    }`}>
                                        {r.status === 'SUCCESS' ? <CheckCircle className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                                        {r.status}
                                    </div>
                                </td>
                                <td className="px-6 py-4 text-slate-600 text-xs">
                                    <div className="font-medium">{r.allocator}</div>
                                    <div className="text-slate-400">{r.transmitter}</div>
                                </td>
                                <td className="px-6 py-4 text-right font-mono text-slate-600">
                                    {fmtBytes(r.dataSizeMB)}
                                </td>
                                <td className="px-6 py-4 text-right font-mono font-bold text-slate-800">
                                    {fmtSpeed(r.throughputBps)}
                                </td>
                                <td className="px-6 py-4 text-right">
                                    <button 
                                        onClick={() => setSelectedResult(r)}
                                        className="text-slate-400 hover:text-blue-600 transition-colors p-2 hover:bg-blue-50 rounded-full"
                                    >
                                        <FileText className="w-4 h-4" />
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {processedResults.length === 0 && (
                    <div className="p-12 text-center text-slate-400">
                        条件に一致する結果が見つかりません。
                    </div>
                )}
            </div>
        </div>
    </div>
  );
};

export default LibraryLayer;