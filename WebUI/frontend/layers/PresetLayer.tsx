import React, { useState } from 'react';
import { ExperimentPreset } from '../types';
import { Trash2, FileText, Clock, Settings2, X, Database, Puzzle, Network, AlertTriangle, ArrowRight, Layers, Hash, ChevronDown, Monitor, Bookmark } from 'lucide-react';
import { Card, SlideOver, Badge, Modal, PageHeader, Button } from '../components/Shared';

interface PresetLayerProps {
    presets: ExperimentPreset[];
    onDeletePreset: (id: string) => void;
}

/**
 * Preset Layer
 * 
 * 実験設定のテンプレート（プリセット）を管理する画面。
 * 保存された設定を視覚的にわかりやすくカード形式で表示し、ワンクリックで詳細確認や削除を行えます。
 */
const PresetLayer: React.FC<PresetLayerProps> = ({ presets, onDeletePreset }) => {
    const [selectedPreset, setSelectedPreset] = useState<ExperimentPreset | null>(null);
    const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

    const handleDeleteClick = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        e.preventDefault();
        setDeleteTargetId(id);
    };

    const confirmDelete = () => {
        if (deleteTargetId) {
            onDeletePreset(deleteTargetId);
            if (selectedPreset?.id === deleteTargetId) {
                setSelectedPreset(null);
            }
            setDeleteTargetId(null);
        }
    };

    // 表示用ヘルパー関数
    const getSizeDisplay = (preset: ExperimentPreset) => preset.generatorState ? (preset.generatorState.dataSize.mode === 'range' ? `${preset.generatorState.dataSize.start}-${preset.generatorState.dataSize.end}MB` : `${preset.generatorState.dataSize.fixed}MB`) : `${preset.config.virtualConfig?.sizeMB || 0}MB`;
    const getChunkDisplay = (preset: ExperimentPreset) => preset.generatorState ? (preset.generatorState.chunkSize.mode === 'range' ? `${preset.generatorState.chunkSize.start}-${preset.generatorState.chunkSize.end}KB` : `${preset.generatorState.chunkSize.fixed}KB`) : `${preset.config.virtualConfig?.chunkSizeKB}KB`;
    const getChainCount = (preset: ExperimentPreset) => preset.generatorState ? preset.generatorState.selectedChains.length : preset.config.targetChains.length;

    const DetailRow = ({ label, value, icon: Icon, subValue }: { label: string, value: React.ReactNode, icon?: any, subValue?: string }) => (
        <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
            <div className="flex items-center gap-4">
                {Icon && <div className="p-2.5 bg-white rounded-xl shadow-sm text-slate-500"><Icon className="w-5 h-5" /></div>}
                <div>
                    <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">{label}</div>
                    {subValue && <div className="text-[10px] text-slate-400 mt-0.5">{subValue}</div>}
                </div>
            </div>
            <div className="font-mono font-bold text-slate-700 text-sm">{value}</div>
        </div>
    );

    const RangeVisualizer = ({ label, start, end, step, unit }: { label: string, start: number, end: number, step: number, unit: string }) => (
        <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100 relative overflow-hidden">
            <div className="flex justify-between items-center mb-4">
                <span className="text-xs font-bold text-slate-500 uppercase flex items-center gap-2">
                    <Layers className="w-4 h-4" /> {label} Range
                </span>
                <Badge color="indigo" className="font-mono">Step: {step}{unit}</Badge>
            </div>
            <div className="flex items-center justify-between font-mono font-bold text-slate-700 relative z-10 px-2">
                <div className="flex flex-col items-center">
                    <span className="text-2xl">{start}</span>
                    <span className="text-[10px] text-slate-400">{unit}</span>
                </div>
                <div className="flex-1 mx-6 h-1.5 bg-slate-200 rounded-full relative">
                    <div className="absolute inset-0 bg-gradient-to-r from-indigo-300 to-indigo-500 opacity-50 rounded-full"></div>
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-full p-1 shadow-sm border border-indigo-100">
                        <ArrowRight className="w-3 h-3 text-indigo-500" />
                    </div>
                </div>
                <div className="flex flex-col items-center">
                    <span className="text-2xl">{end}</span>
                    <span className="text-[10px] text-slate-400">{unit}</span>
                </div>
            </div>
        </div>
    );

    return (
        <div className="h-full flex flex-col pb-10">
            <PageHeader 
                title="Experiment Presets" 
                description="保存された実験設定のテンプレート管理" 
                icon={Bookmark}
                iconColor="text-orange-500"
                action={<Badge color="slate" className="text-sm py-2 px-4">{presets.length} Presets</Badge>}
            />

            {/* Delete Confirmation Modal */}
            <Modal isOpen={!!deleteTargetId} onClose={() => setDeleteTargetId(null)} className="max-w-sm w-full p-8 text-center">
                <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-6">
                    <AlertTriangle className="w-8 h-8 text-red-500" />
                </div>
                <h3 className="text-xl font-bold text-slate-800 mb-2">プリセット削除</h3>
                <p className="text-sm text-slate-500 mb-8 leading-relaxed px-2">
                    保存された設定は完全に削除されます。<br/>本当によろしいですか？
                </p>
                <div className="flex gap-4 justify-center">
                    <Button variant="secondary" onClick={() => setDeleteTargetId(null)}>キャンセル</Button>
                    <Button variant="danger" onClick={confirmDelete}>削除する</Button>
                </div>
            </Modal>

            <div className="flex-1 overflow-y-auto custom-scrollbar pr-2">
                {presets.length === 0 ? (
                    <div className="h-96 flex flex-col items-center justify-center text-slate-400 border-2 border-dashed border-slate-200 rounded-3xl bg-slate-50/30">
                        <div className="p-4 bg-slate-100 rounded-full mb-4"><FileText className="w-8 h-8 opacity-50" /></div>
                        <p className="font-bold">保存されたプリセットはありません</p>
                        <p className="text-sm mt-1">Experiment画面から新しいプリセットを保存してください。</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6 pb-10">
                        {presets.map(preset => (
                            <Card 
                                key={preset.id} 
                                onClick={() => setSelectedPreset(preset)} 
                                className={`p-6 h-full group hover:shadow-xl transition-all duration-300 cursor-pointer relative flex flex-col justify-between border-2 ${selectedPreset?.id === preset.id ? 'border-blue-500 ring-4 ring-blue-50 shadow-xl' : 'border-transparent hover:border-blue-200'}`}
                            >
                                <div>
                                    <div className="flex justify-between items-start mb-4">
                                        <div className="flex items-center gap-4 overflow-hidden">
                                            <div className={`w-12 h-12 shrink-0 rounded-2xl flex items-center justify-center shadow-sm ${selectedPreset?.id === preset.id ? 'bg-blue-600 text-white' : 'bg-slate-50 text-slate-500'}`}>
                                                <FileText className="w-6 h-6" />
                                            </div>
                                            <div className="min-w-0">
                                                <h3 className={`font-bold text-lg truncate ${selectedPreset?.id === preset.id ? 'text-blue-700' : 'text-slate-800'}`} title={preset.name}>{preset.name}</h3>
                                                <div className="flex items-center gap-2 text-xs text-slate-400 font-medium mt-1"><Clock className="w-3 h-3" />{new Date(preset.lastModified).toLocaleString('ja-JP')}</div>
                                            </div>
                                        </div>
                                        <Button 
                                            variant="ghost"
                                            size="sm"
                                            onClick={(e) => handleDeleteClick(e, preset.id)} 
                                            className="text-slate-300 hover:text-red-500 hover:bg-red-50 w-8 h-8 p-0 rounded-full opacity-0 group-hover:opacity-100 transition-all" 
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </Button>
                                    </div>
                                    <div className="flex flex-wrap gap-2 mt-6">
                                        <Badge color="blue" className="flex items-center gap-1.5"><Database className="w-3 h-3"/>{getSizeDisplay(preset)}</Badge>
                                        <Badge color="purple" className="flex items-center gap-1.5"><Puzzle className="w-3 h-3"/>{getChunkDisplay(preset)}</Badge>
                                        <Badge color="green" className="flex items-center gap-1.5"><Monitor className="w-3 h-3"/>{getChainCount(preset)} Chains</Badge>
                                    </div>
                                </div>
                            </Card>
                        ))}
                    </div>
                )}
            </div>

            {/* リッチな詳細パネル */}
            <SlideOver isOpen={!!selectedPreset} title="Preset Details" onClose={() => setSelectedPreset(null)} width="w-[500px]">
                {selectedPreset && (
                    <div className="flex flex-col h-full">
                        <div className="bg-slate-900 p-8 text-white shrink-0 relative overflow-hidden">
                            <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -mr-10 -mt-10 blur-2xl"></div>
                            <div className="relative z-10">
                                <div className="flex items-center gap-3 mb-3 opacity-70">
                                    <Settings2 className="w-4 h-4" />
                                    <span className="text-xs font-mono tracking-wider uppercase">Configuration</span>
                                </div>
                                <h2 className="text-3xl font-bold mb-3 leading-tight">{selectedPreset.name}</h2>
                                <div className="flex items-center gap-4 text-xs font-mono opacity-50">
                                    <span>ID: {selectedPreset.id.substring(0, 8)}...</span>
                                </div>
                            </div>
                        </div>

                        <div className="p-8 space-y-10 flex-1 overflow-y-auto custom-scrollbar bg-white">
                            <section>
                                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2"><Hash className="w-4 h-4"/> Overview Stats</h4>
                                <div className="grid grid-cols-3 gap-4">
                                    <div className="p-4 bg-blue-50 rounded-2xl border border-blue-100 text-center hover:scale-105 transition-transform">
                                        <div className="text-blue-600 mb-2 flex justify-center"><Database className="w-6 h-6" /></div>
                                        <div className="text-xs text-slate-500 font-bold uppercase mb-1">Size</div>
                                        <div className="font-bold text-slate-800 text-lg">{getSizeDisplay(selectedPreset)}</div>
                                    </div>
                                    <div className="p-4 bg-purple-50 rounded-2xl border border-purple-100 text-center hover:scale-105 transition-transform">
                                        <div className="text-purple-600 mb-2 flex justify-center"><Puzzle className="w-6 h-6" /></div>
                                        <div className="text-xs text-slate-500 font-bold uppercase mb-1">Chunk</div>
                                        <div className="font-bold text-slate-800 text-lg">{getChunkDisplay(selectedPreset)}</div>
                                    </div>
                                    <div className="p-4 bg-emerald-50 rounded-2xl border border-emerald-100 text-center hover:scale-105 transition-transform">
                                        <div className="text-emerald-600 mb-2 flex justify-center"><Monitor className="w-6 h-6" /></div>
                                        <div className="text-xs text-slate-500 font-bold uppercase mb-1">Targets</div>
                                        <div className="font-bold text-slate-800 text-lg">{getChainCount(selectedPreset)} Nodes</div>
                                    </div>
                                </div>
                            </section>

                            <section className="space-y-4">
                                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2"><Settings2 className="w-4 h-4"/> Parameters</h4>
                                
                                <DetailRow 
                                    label="Data Source" 
                                    value={selectedPreset.config.uploadType} 
                                    icon={FileText} 
                                    subValue={selectedPreset.config.uploadType === 'Virtual' ? 'Generated on-the-fly' : 'Physical files'}
                                />

                                {selectedPreset.generatorState?.dataSize.mode === 'range' ? (
                                    <RangeVisualizer 
                                        label="Data Size" 
                                        start={selectedPreset.generatorState.dataSize.start} 
                                        end={selectedPreset.generatorState.dataSize.end} 
                                        step={selectedPreset.generatorState.dataSize.step} 
                                        unit="MB" 
                                    />
                                ) : (
                                    <DetailRow label="Data Size (Fixed)" value={`${selectedPreset.generatorState?.dataSize.fixed} MB`} icon={Database} />
                                )}

                                {selectedPreset.generatorState?.chunkSize.mode === 'range' ? (
                                    <RangeVisualizer 
                                        label="Chunk Size" 
                                        start={selectedPreset.generatorState.chunkSize.start} 
                                        end={selectedPreset.generatorState.chunkSize.end} 
                                        step={selectedPreset.generatorState.chunkSize.step} 
                                        unit="KB" 
                                    />
                                ) : (
                                    <DetailRow label="Chunk Size (Fixed)" value={`${selectedPreset.generatorState?.chunkSize.fixed} KB`} icon={Puzzle} />
                                )}
                            </section>

                            <section>
                                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2"><Network className="w-4 h-4"/> Strategies</h4>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="p-5 rounded-2xl border border-slate-200 hover:border-blue-400 transition-colors group bg-slate-50/50">
                                        <div className="text-xs text-slate-400 font-bold uppercase mb-2">Allocator</div>
                                        <div className="text-xl font-bold text-slate-800 group-hover:text-blue-600 transition-colors">{selectedPreset.config.allocator}</div>
                                    </div>
                                    <div className="p-5 rounded-2xl border border-slate-200 hover:border-purple-400 transition-colors group bg-slate-50/50">
                                        <div className="text-xs text-slate-400 font-bold uppercase mb-2">Transmitter</div>
                                        <div className="text-xl font-bold text-slate-800 group-hover:text-purple-600 transition-colors">{selectedPreset.config.transmitter}</div>
                                    </div>
                                </div>
                            </section>

                            <section className="pt-6 border-t border-slate-100">
                                <details className="group">
                                    <summary className="flex items-center justify-between cursor-pointer list-none text-slate-400 hover:text-slate-600 transition-colors p-2 hover:bg-slate-50 rounded-xl">
                                        <span className="text-xs font-bold uppercase">View Raw Config</span>
                                        <ChevronDown className="w-4 h-4 group-open:rotate-180 transition-transform" />
                                    </summary>
                                    <div className="mt-4 bg-slate-900 rounded-2xl p-6 overflow-x-auto shadow-inner border border-slate-700">
                                        <pre className="text-[10px] font-mono text-slate-300 leading-relaxed">
                                            {JSON.stringify(selectedPreset.generatorState || selectedPreset.config, null, 2)}
                                        </pre>
                                    </div>
                                </details>
                            </section>
                        </div>
                    </div>
                )}
            </SlideOver>
        </div>
    );
};

export default PresetLayer;