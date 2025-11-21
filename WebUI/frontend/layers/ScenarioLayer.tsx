import React, { useState } from 'react';
import { ExperimentScenario, ExperimentConfig } from '../types';
import { Trash2, FileText, Clock, Settings2, X, ChevronRight } from 'lucide-react';

interface ScenarioLayerProps {
    scenarios: ExperimentScenario[];
    onDeleteScenario: (id: string) => void;
}

const ScenarioLayer: React.FC<ScenarioLayerProps> = ({ scenarios, onDeleteScenario }) => {
    const [selectedScenario, setSelectedScenario] = useState<ExperimentScenario | null>(null);

    const handleDelete = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        if (window.confirm('本当にこのシナリオを削除しますか？')) {
            onDeleteScenario(id);
            if (selectedScenario?.id === id) {
                setSelectedScenario(null);
            }
        }
    };

    return (
        <div className="h-full flex gap-6">
            {/* List Section */}
            <div className="flex-1 flex flex-col space-y-6 overflow-hidden">
                <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex justify-between items-center">
                    <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                        <Settings2 className="w-5 h-5 text-blue-600" />
                        保存済みシナリオ一覧
                    </h2>
                    <span className="text-sm text-slate-500 font-mono">{scenarios.length} Scenarios</span>
                </div>

                <div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 pb-10">
                    {scenarios.length === 0 ? (
                        <div className="text-center p-10 text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-300">
                            保存されたシナリオはありません。実験画面からシナリオを保存してください。
                        </div>
                    ) : (
                        scenarios.map(scenario => (
                            <div 
                                key={scenario.id}
                                onClick={() => setSelectedScenario(scenario)}
                                className={`bg-white p-4 rounded-xl border transition-all cursor-pointer hover:shadow-md group ${
                                    selectedScenario?.id === scenario.id 
                                    ? 'border-blue-500 ring-1 ring-blue-500 shadow-md' 
                                    : 'border-slate-200 shadow-sm hover:border-blue-300'
                                }`}
                            >
                                <div className="flex justify-between items-start">
                                    <div className="flex items-start gap-3">
                                        <div className={`mt-1 w-8 h-8 rounded-lg flex items-center justify-center ${
                                            selectedScenario?.id === scenario.id ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500'
                                        }`}>
                                            <FileText className="w-4 h-4" />
                                        </div>
                                        <div>
                                            <h3 className={`font-bold text-base ${selectedScenario?.id === scenario.id ? 'text-blue-700' : 'text-slate-700'}`}>
                                                {scenario.name}
                                            </h3>
                                            <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                                                <span className="flex items-center gap-1">
                                                    <Clock className="w-3 h-3" />
                                                    {new Date(scenario.lastModified).toLocaleString('ja-JP')}
                                                </span>
                                                <span className="px-2 py-0.5 bg-slate-100 rounded border border-slate-200 font-mono">
                                                    {scenario.config.projectName || 'No Project Name'}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                    <button 
                                        onClick={(e) => handleDelete(e, scenario.id)}
                                        className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                                        title="削除"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                                
                                {/* Config Summary Chips */}
                                <div className="flex gap-2 mt-3 ml-11">
                                    <span className="px-2 py-1 bg-slate-50 text-slate-600 text-xs rounded border border-slate-100">
                                        {scenario.config.allocator}
                                    </span>
                                    <span className="px-2 py-1 bg-slate-50 text-slate-600 text-xs rounded border border-slate-100">
                                        {scenario.config.transmitter}
                                    </span>
                                    <span className="px-2 py-1 bg-slate-50 text-slate-600 text-xs rounded border border-slate-100">
                                        {scenario.config.uploadType}
                                    </span>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>

            {/* Detail Panel (Right Side) */}
            <div className={`w-96 bg-white border-l border-slate-200 shadow-xl transition-all duration-300 flex flex-col ${
                selectedScenario ? 'translate-x-0' : 'translate-x-full hidden'
            }`}>
                {selectedScenario && (
                    <>
                        <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
                            <h3 className="font-bold text-slate-800">シナリオ詳細</h3>
                            <button onClick={() => setSelectedScenario(null)} className="text-slate-400 hover:text-slate-600">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="p-6 overflow-y-auto flex-1 custom-scrollbar space-y-6">
                            <div>
                                <label className="text-xs font-bold text-slate-400 uppercase">シナリオ名</label>
                                <div className="text-slate-800 font-medium mt-1">{selectedScenario.name}</div>
                            </div>
                            
                            <div className="space-y-4">
                                <h4 className="text-sm font-bold text-slate-700 border-b border-slate-100 pb-2">設定パラメータ</h4>
                                
                                <div className="grid grid-cols-2 gap-4 text-sm">
                                    <div>
                                        <div className="text-slate-500 text-xs mb-1">Allocator</div>
                                        <div className="font-mono bg-slate-50 p-1.5 rounded border border-slate-100">
                                            {selectedScenario.config.allocator}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-slate-500 text-xs mb-1">Transmitter</div>
                                        <div className="font-mono bg-slate-50 p-1.5 rounded border border-slate-100">
                                            {selectedScenario.config.transmitter}
                                        </div>
                                    </div>
                                </div>

                                <div>
                                    <div className="text-slate-500 text-xs mb-1">Upload Type</div>
                                    <div className="font-mono bg-slate-50 p-1.5 rounded border border-slate-100 flex items-center gap-2">
                                        {selectedScenario.config.uploadType}
                                    </div>
                                </div>

                                {selectedScenario.config.uploadType === 'Virtual' && selectedScenario.config.virtualConfig && (
                                    <div className="bg-blue-50 p-3 rounded-lg border border-blue-100 space-y-2">
                                        <div className="text-xs font-bold text-blue-600 mb-2">仮想データ設定</div>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-blue-800">サイズ</span>
                                            <span className="font-mono">{selectedScenario.config.virtualConfig.sizeMB} MB</span>
                                        </div>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-blue-800">チャンク</span>
                                            <span className="font-mono">{selectedScenario.config.virtualConfig.chunkSizeKB} KB</span>
                                        </div>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-blue-800">ファイル数</span>
                                            <span className="font-mono">{selectedScenario.config.virtualConfig.files}</span>
                                        </div>
                                    </div>
                                )}

                                {selectedScenario.config.uploadType === 'Real' && selectedScenario.config.realConfig && (
                                    <div className="bg-emerald-50 p-3 rounded-lg border border-emerald-100 space-y-2">
                                        <div className="text-xs font-bold text-emerald-600 mb-2">実ファイル設定</div>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-emerald-800">合計サイズ</span>
                                            <span className="font-mono">{selectedScenario.config.realConfig.totalSizeMB.toFixed(2)} MB</span>
                                        </div>
                                        <div className="flex justify-between text-xs">
                                            <span className="text-emerald-800">ファイル数</span>
                                            <span className="font-mono">{selectedScenario.config.realConfig.fileCount}</span>
                                        </div>
                                    </div>
                                )}

                                <div>
                                    <div className="text-slate-500 text-xs mb-1">Target Chains</div>
                                    <div className="flex flex-wrap gap-1">
                                        {selectedScenario.config.targetChains.map(chain => (
                                            <span key={chain} className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded border border-slate-200">
                                                {chain}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default ScenarioLayer;
