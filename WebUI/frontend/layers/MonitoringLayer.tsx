
import React, { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import TopologyGraph from '../components/TopologyGraph';
import { generateMockNodes } from '../services/mockData';
import { NodeStatus } from '../types';
import { Activity, Box, Network } from 'lucide-react';

interface MonitoringLayerProps {
    deployedNodeCount: number;
}

const MonitoringLayer: React.FC<MonitoringLayerProps> = ({ deployedNodeCount }) => {
  const [nodes, setNodes] = useState<NodeStatus[]>([]);
  const [mempoolData, setMempoolData] = useState<any[]>([]);

  // Initialize and Simulation Loop
  useEffect(() => {
    setNodes(generateMockNodes(deployedNodeCount)); // Start with deployed count

    const interval = setInterval(() => {
      // Update mempool data randomly
      setMempoolData(prev => {
        // If empty or size mismatch, recreate
        if (prev.length !== deployedNodeCount) {
            return Array.from({ length: deployedNodeCount }, (_, i) => ({
                name: `data-${i}`,
                txs: Math.floor(Math.random() * 200),
            }));
        }
        // Update values
        return prev.map(item => ({
            ...item,
            txs: Math.max(0, item.txs + (Math.random() > 0.5 ? 10 : -20) + Math.floor(Math.random() * 10))
        }));
      });

      // Slightly update block height for nodes
      setNodes(currentNodes => {
          if (currentNodes.length !== 2 + deployedNodeCount) {
              return generateMockNodes(deployedNodeCount);
          }
          return currentNodes.map(n => ({
              ...n,
              height: n.height + (Math.random() > 0.8 ? 1 : 0),
              txCount: Math.floor(Math.random() * 50)
          }));
      });

    }, 1000);

    return () => clearInterval(interval);
  }, [deployedNodeCount]);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      
      {/* Top Row: Topology (Full Width) */}
      <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-200">
          <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                  <Network className="w-4 h-4 text-blue-500" />
                  ネットワークトポロジー
              </h3>
              <div className="text-sm text-slate-500">
                  稼働ノード数: <span className="font-mono font-bold text-emerald-600">{nodes.filter(n => n.status === 'active').length}</span>
              </div>
          </div>
          <TopologyGraph nodes={nodes} />
      </div>

      {/* Middle Row: Mempool Monitor (Full Width) */}
      <div className="bg-white rounded-xl p-6 shadow-sm border border-slate-200">
          <div className="flex items-center gap-2 mb-2">
              <Activity className="w-5 h-5 text-orange-500" />
              <h3 className="text-lg font-bold text-slate-800">Mempool リアルタイムグラフ</h3>
          </div>
          <p className="text-xs text-slate-500 mb-6">各DataChainにおける未処理トランザクションの滞留状況</p>
          
          <div className="w-full h-[250px]">
              <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={mempoolData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                      <XAxis dataKey="name" tick={{fontSize: 12, fill: '#64748b'}} axisLine={false} tickLine={false} />
                      <YAxis tick={{fontSize: 12, fill: '#64748b'}} axisLine={false} tickLine={false} label={{ value: 'Pending Txs', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#94a3b8' }}/>
                      <Tooltip 
                          cursor={{fill: '#f8fafc'}}
                          contentStyle={{borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'}}
                      />
                      <Bar dataKey="txs" radius={[4, 4, 0, 0]} barSize={60}>
                          {mempoolData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.txs > 150 ? '#ef4444' : '#3b82f6'} />
                          ))}
                      </Bar>
                  </BarChart>
              </ResponsiveContainer>
          </div>
      </div>

      {/* Bottom: Node List */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
            <h3 className="font-bold text-slate-800">ブロック生成モニター</h3>
        </div>
        <table className="w-full text-sm text-left">
            <thead className="bg-slate-50 text-slate-500 font-medium">
                <tr>
                    <th className="px-6 py-3">Chain ID</th>
                    <th className="px-6 py-3">Role</th>
                    <th className="px-6 py-3">Status</th>
                    <th className="px-6 py-3 text-right">Block Height</th>
                    <th className="px-6 py-3 text-right">Tx Count (Latest)</th>
                    <th className="px-6 py-3 text-right">Latency (ms)</th>
                </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
                {nodes.map((node) => (
                    <tr key={node.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-3 font-mono font-medium text-slate-700">{node.id}</td>
                        <td className="px-6 py-3">
                            <span className={`px-2 py-1 rounded text-xs font-bold ${
                                node.type === 'control' ? 'bg-blue-100 text-blue-700' :
                                node.type === 'meta' ? 'bg-purple-100 text-purple-700' :
                                'bg-emerald-100 text-emerald-700'
                            }`}>
                                {node.type.toUpperCase()}
                            </span>
                        </td>
                        <td className="px-6 py-3">
                            <div className="flex items-center gap-2">
                                <span className={`w-2 h-2 rounded-full ${node.status === 'active' ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
                                <span className={node.status === 'active' ? 'text-emerald-700' : 'text-red-700'}>
                                    {node.status === 'active' ? '稼働中' : '停止中'}
                                </span>
                            </div>
                        </td>
                        <td className="px-6 py-3 text-right font-mono flex justify-end items-center gap-2">
                            <Box className="w-3 h-3 text-slate-400" />
                            {node.height.toLocaleString()}
                        </td>
                        <td className="px-6 py-3 text-right font-mono text-slate-600">
                             {node.txCount}
                        </td>
                        <td className="px-6 py-3 text-right font-mono text-slate-500">
                            {node.latency}ms
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
      </div>
    </div>
  );
};

export default MonitoringLayer;
