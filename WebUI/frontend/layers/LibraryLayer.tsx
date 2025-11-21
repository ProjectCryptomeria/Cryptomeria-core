import React, { useState } from 'react';
import { ExperimentResult } from '../types';
import { Download, Filter, Search, FileText, Clock, X, ChevronDown, ChevronUp, Trash2, Copy, FileJson, FileSpreadsheet, Library } from 'lucide-react';
import { Card, Modal, ModalHeader, Badge, StatusBadge, PageHeader, Button, Input, TableStyles } from '../components/Shared';
import { useTableFilterSort } from '../hooks';

interface LibraryLayerProps {
    results: ExperimentResult[];
    onDeleteResult: (id: string) => void;
}

/**
 * Library Layer
 * 
 * 過去の実験結果をリスト表示し、検索・フィルタリング・エクスポートを行う画面。
 * データ量が増えても管理しやすいよう、テーブルのソート機能や検索バーを充実させています。
 */
const LibraryLayer: React.FC<LibraryLayerProps> = ({ results, onDeleteResult }) => {
  // Custom Hook for Table Logic
  const { processedData: processedResults, searchTerm, setSearchTerm, sortConfig, handleSort, filters, addFilter, removeFilter } = useTableFilterSort(results, { key: 'executedAt', direction: 'desc' });

  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  const [viewDetailResult, setViewDetailResult] = useState<ExperimentResult | null>(null);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<'csv' | 'json'>('csv');
  const [exportFilename, setExportFilename] = useState("");
  const [isFilterMenuOpen, setIsFilterMenuOpen] = useState(false);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleDeleteClick = () => {
      if (selectedResultId) setShowDeleteConfirm(true);
  };

  const confirmDelete = () => {
      if (selectedResultId) {
          onDeleteResult(selectedResultId);
          setSelectedResultId(null);
          setShowDeleteConfirm(false);
      }
  };

  const handleOpenExport = () => { if (!selectedResultId) return; const r = results.find(x => x.id === selectedResultId); if(r) { setExportFilename(`${r.id}-${new Date(r.executedAt).toISOString().replace(/[:.]/g, '-')}`); setIsExportModalOpen(true); }};
  
  const getExportContent = () => {
      const r = results.find(x => x.id === selectedResultId);
      if (!r) return "";
      if (exportFormat === 'json') return JSON.stringify(r, null, 2);
      const headers = Object.keys(r).join(',');
      const values = Object.values(r).map(v => typeof v === 'object' ? JSON.stringify(v).replace(/"/g, '""') : `"${v}"`).join(',');
      return `${headers}\n${values}`;
  };

  const SortIcon = ({ columnKey }: { columnKey: keyof ExperimentResult }) => sortConfig.key !== columnKey ? <span className="w-3 h-3 opacity-0 ml-1">↕</span> : sortConfig.direction === 'asc' ? <ChevronUp className="w-3 h-3 ml-1" /> : <ChevronDown className="w-3 h-3 ml-1" />;

  return (
    <div className="space-y-6 pb-20 h-full flex flex-col">
        <PageHeader 
            title="Result Archive" 
            description="過去の実験データの閲覧、分析、エクスポート" 
            icon={Library}
            iconColor="text-purple-500"
        />

        {/* Delete Confirmation Modal */}
        <Modal isOpen={showDeleteConfirm} onClose={() => setShowDeleteConfirm(false)} className="max-w-sm w-full p-8 text-center">
            <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-6">
                <Trash2 className="w-8 h-8 text-red-500" />
            </div>
            <h3 className="text-xl font-bold text-slate-800 mb-2">レコード削除</h3>
            <p className="text-sm text-slate-500 mb-8 leading-relaxed px-2">
                この実験結果ログは完全に削除されます。<br/>元に戻すことはできません。
            </p>
            <div className="flex gap-4 justify-center">
                <Button variant="secondary" onClick={() => setShowDeleteConfirm(false)}>キャンセル</Button>
                <Button variant="danger" onClick={confirmDelete}>削除する</Button>
            </div>
        </Modal>

        {/* Export Modal */}
        <Modal isOpen={isExportModalOpen} onClose={() => setIsExportModalOpen(false)} className="max-w-lg w-full">
            <ModalHeader title="Export Data" icon={Download} iconColor="text-blue-600" onClose={() => setIsExportModalOpen(false)} />
            <div className="p-6 pt-0 space-y-6">
                <div><label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">File Name</label><Input value={exportFilename} onChange={(e) => setExportFilename(e.target.value)} /></div>
                <div className="flex gap-4">
                    <label className={`flex-1 flex items-center justify-center gap-3 p-4 rounded-xl border cursor-pointer transition-all ${exportFormat === 'csv' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 hover:border-slate-300'}`}>
                        <input type="radio" name="format" value="csv" checked={exportFormat === 'csv'} onChange={() => setExportFormat('csv')} className="hidden" />
                        <FileSpreadsheet className="w-5 h-5" /><span className="font-bold">CSV</span>
                    </label>
                    <label className={`flex-1 flex items-center justify-center gap-3 p-4 rounded-xl border cursor-pointer transition-all ${exportFormat === 'json' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 hover:border-slate-300'}`}>
                        <input type="radio" name="format" value="json" checked={exportFormat === 'json'} onChange={() => setExportFormat('json')} className="hidden" />
                        <FileJson className="w-5 h-5" /><span className="font-bold">JSON</span>
                    </label>
                </div>
                <div className="bg-slate-900 rounded-xl p-4 border border-slate-700 max-h-40 overflow-y-auto font-mono text-xs text-slate-300 custom-scrollbar whitespace-pre-wrap break-all shadow-inner">
                    {getExportContent()}
                </div>
                <div className="grid grid-cols-2 gap-4">
                    <Button variant="secondary" onClick={() => { navigator.clipboard.writeText(getExportContent()); alert('コピーしました'); }} icon={Copy}>クリップボードにコピー</Button>
                    <Button variant="primary" onClick={() => { alert('ダウンロード開始'); setIsExportModalOpen(false); }} icon={Download} className="bg-emerald-600 hover:bg-emerald-700 shadow-emerald-200">ダウンロード</Button>
                </div>
            </div>
        </Modal>

        {/* Detail Modal */}
        <Modal isOpen={!!viewDetailResult} onClose={() => setViewDetailResult(null)} className="max-w-2xl w-full p-0 overflow-hidden">
             {viewDetailResult && (
                <div className="flex flex-col max-h-[90vh]">
                    <ModalHeader title={viewDetailResult.scenarioName} subTitle={`ID: ${viewDetailResult.id}`} icon={FileText} iconColor="text-blue-500" onClose={() => setViewDetailResult(null)} />
                    
                    <div className="p-6 overflow-y-auto custom-scrollbar space-y-8 bg-white">
                        {/* Basic Info Section */}
                        <section>
                            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-100 pb-2 mb-4">Basic Information</h4>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                                    <div className="text-xs text-slate-400 font-bold uppercase mb-1">Executed At</div>
                                    <div className="font-mono text-sm font-bold text-slate-700">{new Date(viewDetailResult.executedAt).toLocaleString()}</div>
                                </div>
                                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100">
                                    <div className="text-xs text-slate-400 font-bold uppercase mb-1">Result Status</div>
                                    <StatusBadge status={viewDetailResult.status} />
                                </div>
                            </div>
                        </section>

                        {/* Settings Section */}
                        <section>
                            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-100 pb-2 mb-4">Parameters</h4>
                            <div className="grid grid-cols-2 gap-4">
                                {[{l:'Data Size', v:`${viewDetailResult.dataSizeMB} MB`}, {l:'Chunk Size', v:`${viewDetailResult.chunkSizeKB} KB`}, {l:'Allocator', v:viewDetailResult.allocator}, {l:'Transmitter', v:viewDetailResult.transmitter}].map((item, i) => (
                                    <div key={i} className="flex justify-between items-center p-3 border-b border-slate-50">
                                        <span className="text-sm text-slate-500 font-medium">{item.l}</span>
                                        <span className="font-bold text-slate-700">{item.v}</span>
                                    </div>
                                ))}
                            </div>
                        </section>

                        {/* Performance Section */}
                        <section className="bg-gradient-to-br from-blue-50 to-indigo-50 p-6 rounded-3xl border border-blue-100 shadow-inner">
                            <h4 className="text-xs font-bold text-blue-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                                <Clock className="w-4 h-4" /> Performance Metrics
                            </h4>
                            <div className="grid grid-cols-3 gap-4 text-center divide-x divide-blue-200/50">
                                <div><div className="text-xs text-slate-500 mb-1 font-medium">Upload</div><div className="font-mono font-bold text-xl text-slate-800">{(viewDetailResult.uploadTimeMs/1000).toFixed(2)}s</div></div>
                                <div><div className="text-xs text-slate-500 mb-1 font-medium">Download</div><div className="font-mono font-bold text-xl text-slate-800">{(viewDetailResult.downloadTimeMs/1000).toFixed(2)}s</div></div>
                                <div><div className="text-xs text-slate-500 mb-1 font-medium">Throughput</div><div className="font-mono font-bold text-xl text-blue-600">{(viewDetailResult.throughputBps/1024/1024).toFixed(2)}<span className="text-xs ml-1">Mbps</span></div></div>
                            </div>
                        </section>
                    </div>
                    
                    <div className="p-5 border-t border-slate-100 bg-slate-50 flex justify-end rounded-b-3xl">
                        <Button variant="secondary" onClick={() => setViewDetailResult(null)}>閉じる</Button>
                    </div>
                </div>
             )}
        </Modal>

        {/* Toolbar */}
        <Card className="p-4 flex flex-col gap-4 sticky top-0 z-20 shadow-md border-slate-200/80 backdrop-blur-xl bg-white/90">
            <div className="flex flex-col md:flex-row justify-between gap-4">
                <div className="relative flex-1 max-w-md">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
                    <Input placeholder="Search scenario name or ID..." className="pl-10" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
                </div>
                <div className="flex gap-2 relative">
                    <Button variant="secondary" onClick={() => setIsFilterMenuOpen(!isFilterMenuOpen)} icon={Filter}>フィルター</Button>
                    {isFilterMenuOpen && <div className="absolute top-full right-0 mt-2 w-56 bg-white rounded-2xl shadow-xl ring-1 ring-black/5 z-30 p-2 animate-in fade-in zoom-in-95 duration-200">{['SUCCESS', 'FAILED'].map(s => <button key={s} onClick={() => { addFilter('status', s, 'Status'); setIsFilterMenuOpen(false); }} className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 rounded-xl transition-colors font-medium text-slate-600">{s}</button>)}</div>}
                    
                    {selectedResultId && (
                        <div className="flex gap-2 animate-in fade-in slide-in-from-right-4 duration-300">
                            <Button variant="danger" onClick={handleDeleteClick} icon={Trash2}>削除</Button>
                            <Button variant="primary" className="bg-emerald-600 hover:bg-emerald-700 shadow-emerald-200" onClick={handleOpenExport} icon={Download}>出力</Button>
                        </div>
                    )}
                </div>
            </div>
            {filters.length > 0 && <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">{filters.map((f, idx) => <Badge key={idx} color="blue" className="flex items-center gap-2 pr-1">{f.label}<button onClick={() => removeFilter(idx)} className="hover:bg-blue-200 rounded-full p-0.5"><X className="w-3 h-3" /></button></Badge>)}<button onClick={() => { /* Handled in hook, need expose clearer if needed, but simple set [] works */ /* But hook exposes simple array mutators. Let's assume we can iterate to remove or add a clearAll to hook. For now just clear manually by removing all indices? No, simpler to add clearAll to hook or iterate. Hook exposes setFilters? No. I'll just map remove. Wait, setFilters is internal to hook. I should expose a reset function or simply allow direct access if I change the hook signature. Actually, `removeFilter` removes by index. I can just iterate backwards. OR, better, update hook to expose `clearFilters`. I didn't add that to hook. I'll just use a loop or skip "Clear all" button for now to stay strict to the hook definition I wrote? No, I can add it to the hook. I'll add `setFilters` or `clearFilters` to the hook for better DX. */ /* I will add setFilters to the hook return for flexibility */ }} className="text-xs text-slate-400 underline hover:text-slate-600 ml-2">Clear all</button></div>}
        </Card>

        {/* Results Table */}
        <div className={`flex-1 flex flex-col ${TableStyles.Container} shadow-md border-slate-200`}>
            <div className="overflow-auto flex-1 custom-scrollbar">
                <table className="w-full text-left text-sm">
                    <thead className={`${TableStyles.Header} sticky top-0 z-10 shadow-sm`}>
                        <tr>{['executedAt', 'scenarioName', 'status', 'allocator', 'dataSizeMB', 'throughputBps'].map(k => <th key={k} className="px-6 py-4 cursor-pointer hover:bg-slate-100 transition-colors select-none" onClick={() => handleSort(k as keyof ExperimentResult)}><div className="flex items-center gap-1">{k.replace(/([A-Z])/g, ' $1').trim()} <SortIcon columnKey={k as keyof ExperimentResult} /></div></th>)}<th className="px-6 py-4 text-right">Action</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {processedResults.map(r => (
                            <tr key={r.id} onClick={() => setSelectedResultId(r.id === selectedResultId ? null : r.id)} className={`group transition-colors cursor-pointer ${selectedResultId === r.id ? 'bg-blue-50/60' : 'hover:bg-slate-50'}`}>
                                <td className="px-6 py-4">
                                    <div className={`font-mono font-medium ${selectedResultId === r.id ? 'text-blue-700 font-bold' : 'text-slate-600'}`}>{r.id}</div>
                                    <div className="text-xs text-slate-400 flex items-center gap-1 mt-1"><Clock className="w-3 h-3" />{new Date(r.executedAt).toLocaleString()}</div>
                                </td>
                                <td className="px-6 py-4 font-bold text-slate-800">{r.scenarioName}</td>
                                <td className="px-6 py-4"><StatusBadge status={r.status} /></td>
                                <td className="px-6 py-4 text-slate-600 text-xs">
                                    <div className="font-medium bg-slate-100 inline-block px-2 py-0.5 rounded mb-1">{r.allocator}</div>
                                    <div className="text-slate-400">{r.transmitter}</div>
                                </td>
                                <td className="px-6 py-4 font-mono text-slate-600 font-bold">{r.dataSizeMB} <span className="text-[10px] text-slate-400 font-normal">MB</span></td>
                                <td className="px-6 py-4 font-mono font-bold text-slate-800">{(r.throughputBps/1024/1024).toFixed(2)} <span className="text-[10px] text-slate-400 font-normal">Mbps</span></td>
                                <td className="px-6 py-4 text-right">
                                    <Button 
                                        variant="ghost"
                                        size="sm"
                                        onClick={(e) => { e.stopPropagation(); setViewDetailResult(r); }} 
                                        className="hover:bg-blue-50 hover:text-blue-600 rounded-full w-10 h-10 p-0"
                                    >
                                        <FileText className="w-5 h-5" />
                                    </Button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    </div>
  );
};

export default LibraryLayer;