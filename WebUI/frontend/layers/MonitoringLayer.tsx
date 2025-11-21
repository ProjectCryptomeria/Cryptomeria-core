
import React, { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import TopologyGraph from '../components/TopologyGraph';
import { NodeStatus, MonitoringUpdate } from '../types';
import { Activity, Zap, ChevronUp, ChevronLeft, X, Monitor } from 'lucide-react';
import { Badge, PageHeader } from '../components/Shared';
import { useResizerPanel, useWebSocket } from '../hooks';

interface MonitoringLayerProps {
    setDeployedNodeCount: (n: number) => void;
}

const MonitoringLayer: React.FC<MonitoringLayerProps> = ({ setDeployedNodeCount }) => {
  const [nodes, setNodes] = useState<NodeStatus[]>([]);
  const [mempoolData, setMempoolData] = useState<any[]>([]);
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(false);
  
  const { isOpen: isBottomPanelOpen, setIsOpen: setIsBottomPanelOpen, height: bottomPanelHeight, panelRef, resizerRef } = useResizerPanel(320, 100, 0.8);

  // Subscribe to monitoring updates from Mock Backend
  useWebSocket<MonitoringUpdate>('/ws/monitoring', (data) => {
      setNodes(data.nodes);
      setMempoolData(data.mempool);
      setDeployedNodeCount(data.deployedCount);
  });

  return (
    <div className="flex h-full w-full overflow-hidden relative text-gray-800">
        
        <div className="flex-1 flex flex-col h-full min-w-0 relative z-10">
            <div className="p-6 flex-shrink-0">
                <PageHeader 
                    title="Network Monitoring" 
                    description="リアルタイムのネットワークトポロジーとノードの状態監視" 
                    icon={Activity}
                    iconColor="text-blue-500"
                    action={
                        <div className="flex items-center gap-2">
                             <Badge color="green" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 flex items-center gap-2">
                                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"/>
                                Active Nodes: {nodes.filter(n => n.status === 'active').length}
                            </Badge>
                        </div>
                    }
                />
            </div>

            {/* Main Graph Area: Resizes securely using flex and hidden overflow */}
            <div className="flex-1 p-6 pt-0 pb-32 flex items-center justify-center overflow-hidden">
                <TopologyGraph nodes={nodes} />
            </div>

            <button 
                onClick={() => setIsSidePanelOpen(true)} 
                className={`absolute top-6 right-0 bg-white border border-gray-200 shadow-lg rounded-l-xl p-3 text-slate-500 hover:bg-slate-50 transition-all z-20 ${isSidePanelOpen ? 'translate-x-full opacity-0 pointer-events-none' : 'translate-x-0'}`}
            >
                <ChevronLeft className="w-5 h-5" />
            </button>

            <div 
                ref={panelRef}
                className={`absolute bottom-0 left-0 right-0 bg-white shadow-[0_-10px_40px_rgba(0,0,0,0.1)] z-30 rounded-t-[2rem] border-t border-gray-100 flex flex-col bottom-panel-transition ${isBottomPanelOpen ? '' : 'h-20'}`} 
                style={{ height: isBottomPanelOpen ? bottomPanelHeight : undefined }}
            >
                <div ref={resizerRef} className="absolute top-0 left-0 right-0 h-4 w-full cursor-row-resize z-50 group flex justify-center items-center">
                    <div className="w-16 h-1.5 bg-gray-200 rounded-full group-hover:bg-blue-50 transition-colors"></div>
                </div>

                <div className="px-8 py-4 border-b border-gray-100 flex justify-between items-center bg-white rounded-t-[2rem] cursor-pointer hover:bg-gray-50 transition-colors relative z-40 mt-1" onClick={() => setIsBottomPanelOpen(!isBottomPanelOpen)}>
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-orange-50 text-orange-600 rounded-lg"><Zap className="w-4 h-4" /></div>
                        <div>
                            <h3 className="font-bold text-slate-800 flex items-center gap-2">Mempool Status</h3>
                            <p className="text-[10px] text-slate-500">各DataChainにおける未処理TXの滞留数</p>
                        </div>
                    </div>
                    <div className="w-8 h-8 rounded-full bg-gray-50 flex items-center justify-center text-gray-400 group-hover:bg-white group-hover:shadow-sm transition-all">
                         <ChevronUp className={`w-4 h-4 transition-transform ${isBottomPanelOpen ? 'rotate-180' : ''}`} />
                    </div>
                </div>

                <div className="flex-1 p-6 bg-slate-50/50 overflow-hidden flex flex-col">
                     <div className="flex-1 w-full min-h-0">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={mempoolData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                                <XAxis dataKey="name" tick={{fontSize: 11, fill: '#64748b'}} axisLine={false} tickLine={false} />
                                <YAxis tick={{fontSize: 11, fill: '#64748b'}} axisLine={false} tickLine={false} />
                                <Tooltip 
                                    cursor={{fill: '#f1f5f9'}} 
                                    contentStyle={{borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)', padding: '12px'}}
                                />
                                <Bar dataKey="txs" radius={[6, 6, 0, 0]} maxBarSize={60}>
                                    {mempoolData.map((entry, index) => (
                                      <Cell key={`cell-${index}`} fill={entry.txs > 150 ? '#ef4444' : '#3b82f6'} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                     </div>
                </div>
            </div>
        </div>

        <div className={`flex-shrink-0 border-l border-gray-200 bg-white relative z-20 transition-all duration-300 overflow-hidden flex flex-col ${isSidePanelOpen ? 'w-96' : 'w-0'}`}>
             <div className="p-5 border-b border-gray-100 flex justify-between items-center shrink-0">
                <h2 className="font-bold text-slate-700 flex items-center text-lg">
                    <Monitor className="w-5 h-5 mr-2 text-slate-500" />
                    Node Registry
                </h2>
                <button onClick={() => setIsSidePanelOpen(false)} className="text-gray-400 hover:text-gray-600 p-2 rounded-lg hover:bg-gray-50 transition-colors">
                    <X className="w-5 h-5" />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar bg-slate-50 space-y-3">
                 {nodes.map((node) => (
                    <div key={node.id} className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-all">
                        <div className="flex justify-between items-start mb-2">
                            <div className="flex items-center gap-2">
                                <div className={`w-2 h-2 rounded-full ${node.status === 'active' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                                <span className="font-mono font-bold text-sm text-slate-800">{node.id}</span>
                            </div>
                            <Badge color={node.type === 'control' ? 'blue' : node.type === 'meta' ? 'indigo' : 'slate'}>
                                {node.type}
                            </Badge>
                        </div>
                        
                        <div className="grid grid-cols-2 gap-2 mt-3">
                            <div className="bg-slate-50 p-2 rounded-lg border border-slate-100">
                                <div className="text-[10px] text-slate-400 font-bold uppercase">Height</div>
                                <div className="font-mono text-sm font-bold text-slate-700">{node.height.toLocaleString()}</div>
                            </div>
                            <div className="bg-slate-50 p-2 rounded-lg border border-slate-100">
                                <div className="text-[10px] text-slate-400 font-bold uppercase">Latency</div>
                                <div className={`font-mono text-sm font-bold ${node.latency > 50 ? 'text-orange-500' : 'text-emerald-500'}`}>
                                    {node.latency} ms
                                </div>
                            </div>
                        </div>
                    </div>
                 ))}
            </div>
        </div>
    </div>
  );
};

export default MonitoringLayer;
