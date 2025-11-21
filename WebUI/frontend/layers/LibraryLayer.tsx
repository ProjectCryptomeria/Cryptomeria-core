
import React, { useState, useMemo, useEffect } from 'react';
import { ExperimentResult, SortConfig, FilterCondition, AllocatorStrategy, TransmitterStrategy } from '../types';
import { Download, Filter, Search, FileText, AlertTriangle, CheckCircle, Clock, X, Database, Server, Network, ChevronDown, ChevronUp, Badge, Trash2, Copy, FileJson, FileSpreadsheet } from 'lucide-react';

interface LibraryLayerProps {
    results: ExperimentResult[];
    onDeleteResult: (id: string) => void;
}

const LibraryLayer: React.FC<LibraryLayerProps> = ({ results, onDeleteResult }) => {
  const [searchTerm, setSearchTerm] = useState("");
  // Use selectedResultId for table selection, distinct from "view details" modal
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  const [viewDetailResult, setViewDetailResult] = useState<ExperimentResult | null>(null);
  
  // Export Modal State
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<'csv' | 'json'>('csv');
  const [exportFilename, setExportFilename] = useState("");

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

  const handleDeleteSelected = () => {
      if (!selectedResultId) return;
      if (window.confirm('選択した実験データを完全に削除しますか？この操作は取り消せません。')) {
          onDeleteResult(selectedResultId);
          setSelectedResultId(null);
      }
  };

  const handleOpenExport = () => {
      if (!selectedResultId) return;
      const result = results.find(r => r.id === selectedResultId);
      if (!result) return;

      // Default Filename: ID-Timestamp
      const timestamp = new Date(result.executedAt).toISOString().replace(/[:.]/g, '-');
      setExportFilename(`${result.id}-${timestamp}`);
      setIsExportModalOpen(true);
  };

  const getExportContent = () => {
      const result = results.find(r => r.id === selectedResultId);
      if (!result) return "";

      if (exportFormat === 'json') {
          return JSON.stringify(result, null, 2);
      } else {
          // CSV
          const headers = Object.keys(result).join(',');
          const values = Object.values(result).map(v => {
              if (typeof v === 'object') return JSON.stringify(v).replace(/"/g, '""'); // Simple escape
              return `"${v}"`;
          }).join(',');
          return `${headers}\n${values}`;
      }
  };

  const handleCopyExport = () => {
      const content = getExportContent();
      navigator.clipboard.writeText(content).then(() => {
          alert('クリップボードにコピーしました。');
      });
  };

  const handleDownloadExport = () => {
      const content = getExportContent();
      const blob = new Blob([content], { type: exportFormat === 'json' ? 'application/json' : 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${exportFilename}.${exportFormat}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setIsExportModalOpen(false);
      alert('ダウンロードを開始しました。');
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
        
        {/* Export Modal */}
        {isExportModalOpen && (
             <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="bg-white w-full max-w-lg rounded-xl shadow-2xl border border-slate-200 p-6 animate-in zoom-in-95 duration-200">
                    <div className="flex justify-between items-center mb-4">
                         <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                             <Download className="w-5 h-5 text-blue-600" />
                             データエクスポート
                         </h3>
                         <button onClick={() => setIsExportModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                             <X className="w-5 h-5" />
                         </button>
                    </div>
                    
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">出力ファイル名</label>
                            <input 
                                type="text" 
                                value={exportFilename}
                                onChange={(e) => setExportFilename(e.target.value)}
                                className="w-full p-2 border border-slate-300 rounded-lg text-sm outline-none focus:border-blue-500"
                            />
                        </div>
                        
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">出力形式</label>
                            <div className="flex gap-4">
                                <label className={`flex-1 flex items-center justify-center gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${exportFormat === 'csv' ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-slate-200 hover:bg-slate-50'}`}>
                                    <input type="radio" name="format" value="csv" checked={exportFormat === 'csv'} onChange={() => setExportFormat('csv')} className="hidden" />
                                    <FileSpreadsheet className="w-4 h-4" />
                                    CSV
                                </label>
                                <label className={`flex-1 flex items-center justify-center gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${exportFormat === 'json' ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-slate-200 hover:bg-slate-50'}`}>
                                    <input type="radio" name="format" value="json" checked={exportFormat === 'json'} onChange={() => setExportFormat('json')} className="hidden" />
                                    <FileJson className="w-4 h-4" />
                                    JSON
                                </label>
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">プレビュー</label>
                            <div className="bg-slate-100 rounded-lg p-3 border border-slate-200 max-h-40 overflow-y-auto font-mono text-xs text-slate-600 custom-scrollbar whitespace-pre-wrap break-all">
                                {getExportContent()}
                            </div>
                        </div>

                        <div className="text-center text-sm text-slate-500 my-2">
                            出力予定ファイル: <span className="font-bold text-slate-800">{exportFilename}.{exportFormat}</span>
                        </div>

                        <div className="grid grid-cols-2 gap-3 pt-2">
                            <button 
                                onClick={handleCopyExport}
                                className="py-2 px-4 bg-white border border-slate-300 text-slate-700 rounded-lg font-medium hover:bg-slate-50 transition-colors flex items-center justify-center gap-2"
                            >
                                <Copy className="w-4 h-4" />
                                コピー
                            </button>
                            <button 
                                onClick={handleDownloadExport}
                                className="py-2 px-4 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2"
                            >
                                <Download className="w-4 h-4" />
                                エクスポート
                            </button>
                        </div>
                    </div>
                </div>
             </div>
        )}

        {/* Detail Modal (View Only) */}
        {viewDetailResult && (
            <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="bg-white w-full max-w-3xl rounded-xl shadow-2xl border border-slate-200 flex flex-col max-h-[90vh] overflow-hidden animate-in zoom-in-95 duration-200">
                    <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50">
                        <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-full ${viewDetailResult.status === 'SUCCESS' ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'}`}>
                                {viewDetailResult.status === 'SUCCESS' ? <CheckCircle className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
                            </div>
                            <div>
                                <h3 className="font-bold text-lg text-slate-800">{viewDetailResult.scenarioName}</h3>
                                <div className="text-xs text-slate-500 font-mono">ID: {viewDetailResult.id}</div>
                            </div>
                        </div>
                        <button onClick={() => setViewDetailResult(null)} className="text-slate-400 hover:text-slate-600">
                            <X className="w-6 h-6" />
                        </button>
                    </div>
                    
                    <div className="p-6 overflow-y-auto custom-scrollbar">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                            {/* Details Sections */}
                            <div className="space-y-4">
                                <h4 className="text-sm font-bold text-slate-400 uppercase tracking-wider border-b border-slate-100 pb-2">基本情報</h4>
                                <div className="grid grid-cols-2 gap-4 text-sm">
                                    <div>
                                        <div className="text-slate-500">実行日時</div>
                                        <div className="font-mono">{new Date(viewDetailResult.executedAt).toLocaleString('ja-JP')}</div>
                                    </div>
                                    <div>
                                        <div className="text-slate-500">ステータス</div>
                                        <div className={`font-bold ${viewDetailResult.status === 'SUCCESS' ? 'text-emerald-600' : 'text-red-600'}`}>{viewDetailResult.status}</div>
                                    </div>
                                </div>
                            </div>

                             {/* Section 2: Scenario Config */}
                             <div className="space-y-4">
                                <h4 className="text-sm font-bold text-slate-400 uppercase tracking-wider border-b border-slate-100 pb-2">シナリオ設定</h4>
                                <div className="space-y-2 text-sm">
                                    <div className="flex justify-between">
                                        <span className="text-slate-500 flex items-center gap-2"><Database className="w-3 h-3"/> データサイズ</span>
                                        <span className="font-mono">{fmtBytes(viewDetailResult.dataSizeMB)}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-500 flex items-center gap-2"><Network className="w-3 h-3"/> チャンクサイズ</span>
                                        <span className="font-mono">{viewDetailResult.chunkSizeKB} KB</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">総Tx数</span>
                                        <span className="font-mono">{viewDetailResult.totalTxCount.toLocaleString()}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">Allocator</span>
                                        <span>{viewDetailResult.allocator}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-500">Transmitter</span>
                                        <span>{viewDetailResult.transmitter}</span>
                                    </div>
                                </div>
                            </div>

                            {/* Section 3: Infrastructure Usage */}
                            <div className="space-y-4 md:col-span-2">
                                <h4 className="text-sm font-bold text-slate-400 uppercase tracking-wider border-b border-slate-100 pb-2">インフラ使用状況</h4>
                                <div className="text-sm mb-2">
                                    <span className="text-slate-500">使用したDataChain数: </span>
                                    <span className="font-bold text-slate-800">{viewDetailResult.targetChainCount}</span>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {viewDetailResult.usedChains.map(chain => (
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
                                        <div className="font-mono font-bold text-lg">{fmtTime(viewDetailResult.uploadTimeMs)}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-slate-500 mb-1">ダウンロード時間</div>
                                        <div className="font-mono font-bold text-lg">{fmtTime(viewDetailResult.downloadTimeMs)}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-slate-500 mb-1">スループット</div>
                                        <div className="font-mono font-bold text-lg text-blue-600">{fmtSpeed(viewDetailResult.throughputBps)}</div>
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

                    {/* Action Buttons: Show only when selected */}
                    {selectedResultId ? (
                        <div className="flex gap-2 animate-in slide-in-from-right-5 fade-in">
                            <button 
                                onClick={handleDeleteSelected}
                                className="flex items-center gap-2 px-4 py-2 bg-red-50 border border-red-200 text-red-600 rounded-lg text-sm font-medium hover:bg-red-100 transition-colors"
                            >
                                <Trash2 className="w-4 h-4" />
                                データ削除
                            </button>
                            <button 
                                onClick={handleOpenExport}
                                className="flex items-center gap-2 px-4 py-2 bg-emerald-50 border border-emerald-200 text-emerald-600 rounded-lg text-sm font-medium hover:bg-emerald-100 transition-colors"
                            >
                                <Download className="w-4 h-4" />
                                データエクスポート
                            </button>
                        </div>
                    ) : null}
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
                            <tr 
                                key={r.id} 
                                onClick={() => setSelectedResultId(r.id === selectedResultId ? null : r.id)}
                                className={`group transition-colors cursor-pointer ${
                                    selectedResultId === r.id 
                                    ? 'bg-blue-50/50 border-l-4 border-blue-500' 
                                    : 'hover:bg-slate-50 border-l-4 border-transparent'
                                }`}
                            >
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
                                        onClick={(e) => { e.stopPropagation(); setViewDetailResult(r); }}
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
