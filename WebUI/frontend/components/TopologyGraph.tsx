
import React, { useMemo } from 'react';
import { NodeStatus } from '../types';
import { Server, Database, Cpu } from 'lucide-react';

interface TopologyGraphProps {
  nodes: NodeStatus[];
}

const TopologyGraph: React.FC<TopologyGraphProps> = ({ nodes }) => {
  const controlNode = nodes.find(n => n.type === 'control');
  const metaNode = nodes.find(n => n.type === 'meta');
  const dataNodes = nodes.filter(n => n.type === 'data');

  // Layout Constants
  const nodeSpacing = 160;
  const baseWidth = 1200;
  const height = 450; // Compact height
  
  // Calculate dynamic width based on the number of data nodes
  // If nodes fit in 1200px, use 1200px. Otherwise expand to fit them + margins.
  const canvasWidth = useMemo(() => {
      const requiredWidth = dataNodes.length * nodeSpacing + 200; // 200 for margins
      return Math.max(baseWidth, requiredWidth);
  }, [dataNodes.length]);
  
  // Node Positions based on Data Flow Logic:
  // 1. Control Chain (Top Center) - The orchestrator
  const controlPos = { x: canvasWidth / 2, y: 80 }; // Center horizontally based on dynamic width

  // 2. Meta Chain (Top Right relative to Control)
  const metaPos = { x: canvasWidth / 2 + 250, y: 100 };
  
  // 3. Data Chains (Bottom Row) - Receives fragments from Control
  const dataNodePositions = useMemo(() => {
    const count = dataNodes.length;
    const totalWidth = (count - 1) * nodeSpacing;
    const startX = canvasWidth / 2 - totalWidth / 2;
    
    return dataNodes.map((node, i) => ({
        ...node,
        x: startX + i * nodeSpacing,
        y: 350 // Moved up to fit in smaller height
    }));
  }, [dataNodes, canvasWidth]);

  // Helper to draw orthogonal lines (Manhattan style)
  const drawOrthogonalLine = (x1: number, y1: number, x2: number, y2: number, midYRatio: number = 0.5) => {
      // Calculate a midpoint Y that is between y1 and y2
      const midY = y1 + (y2 - y1) * midYRatio;
      return `M ${x1},${y1} L ${x1},${midY} L ${x2},${midY} L ${x2},${y2}`;
  };

  const drawDirectLine = (x1: number, y1: number, x2: number, y2: number) => {
      return `M ${x1},${y1} L ${x2},${y2}`;
  };

  return (
    <div className="w-full bg-slate-900 rounded-xl border border-slate-800 relative overflow-hidden shadow-inner">
      <div className="absolute top-4 left-4 text-slate-400 text-sm font-mono z-10 pointer-events-none">
        Network Topology Visualization<br/>
        <span className="text-[10px] opacity-70">Flow: Control → Data (Fragments) → Meta (Manifest)</span>
      </div>
      
      <div className="w-full h-full overflow-auto">
        <svg 
            viewBox={`0 0 ${canvasWidth} ${height}`} 
            className="w-full h-auto min-h-[400px] select-none"
            preserveAspectRatio="xMidYMid meet"
        >
            <defs>
                <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur stdDeviation="4" result="coloredBlur"/>
                    <feMerge>
                        <feMergeNode in="coloredBlur"/>
                        <feMergeNode in="SourceGraphic"/>
                    </feMerge>
                </filter>
                <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="#475569" />
                </marker>
            </defs>

            {/* --- Connections --- */}

            {/* 1. Control -> Data (Distribution of Fragments) */}
            {dataNodePositions.map((dn, i) => (
                <g key={`link-control-data-${dn.id}`}>
                    <path 
                        d={drawOrthogonalLine(controlPos.x, controlPos.y + 50, dn.x, dn.y - 45, 0.4 + (i % 2) * 0.1)} 
                        fill="none"
                        stroke="#334155"
                        strokeWidth="2"
                        strokeDasharray="5,5"
                    />
                    {/* Animated Packet (Control -> Data) */}
                    {dn.status === 'active' && (
                         <circle r="3" fill="#3b82f6">
                           <animateMotion 
                             dur={`${2 + Math.random()}s`} 
                             repeatCount="indefinite"
                             path={drawOrthogonalLine(controlPos.x, controlPos.y + 50, dn.x, dn.y - 45, 0.4 + (i % 2) * 0.1)}
                             keyPoints="0;1"
                             keyTimes="0;1"
                             calcMode="linear"
                           />
                         </circle>
                    )}
                </g>
            ))}

            {/* 2. Control -> Meta (Writing Manifest) */}
            <g>
                <path 
                    d={drawDirectLine(controlPos.x + 60, controlPos.y, metaPos.x - 50, metaPos.y)}
                    fill="none"
                    stroke="#6366f1"
                    strokeWidth="3"
                />
                 {/* Packet (Control -> Meta) */}
                 <circle r="4" fill="#a5b4fc">
                    <animateMotion 
                         dur="3s" 
                         repeatCount="indefinite"
                         path={drawDirectLine(controlPos.x + 60, controlPos.y, metaPos.x - 50, metaPos.y)}
                    />
                 </circle>
            </g>


            {/* --- Nodes Rendering --- */}

            {/* Control Chain (Top Center) */}
            <foreignObject x={controlPos.x - 60} y={controlPos.y - 50} width="120" height="100">
                <div className="flex flex-col items-center justify-center">
                    <div className="text-[10px] text-blue-300 mb-1 font-mono">Orchestrator</div>
                    <div className={`w-20 h-20 rounded-xl bg-blue-900/90 border-2 ${controlNode?.status === 'active' ? 'border-blue-400 shadow-[0_0_30px_rgba(59,130,246,0.4)]' : 'border-red-500'} flex items-center justify-center mb-2 backdrop-blur-sm z-20 relative`}>
                         <Server className="w-10 h-10 text-blue-200" />
                         {/* Badge */}
                         <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-1.5 py-0.5 rounded-full border border-blue-900">Main</div>
                    </div>
                    <span className="text-blue-100 font-bold text-sm bg-slate-900/80 px-3 py-1 rounded-full border border-blue-900/50">ControlChain</span>
                </div>
            </foreignObject>

            {/* Meta Chain (Top Right) */}
            <foreignObject x={metaPos.x - 50} y={metaPos.y - 40} width="100" height="100">
                <div className="flex flex-col items-center justify-center">
                     <div className="text-[10px] text-indigo-300 mb-1 font-mono">Registry</div>
                    <div className={`w-16 h-16 rounded-full bg-indigo-900/90 border-2 ${metaNode?.status === 'active' ? 'border-indigo-400 shadow-[0_0_30px_rgba(99,102,241,0.4)]' : 'border-red-500'} flex items-center justify-center mb-2 backdrop-blur-sm z-20`}>
                         <Cpu className="w-8 h-8 text-indigo-200" />
                    </div>
                    <span className="text-indigo-200 font-bold text-xs bg-slate-900/80 px-3 py-1 rounded-full border border-indigo-900/50">MetaChain</span>
                </div>
            </foreignObject>

            {/* Data Chains (Bottom Row) */}
            {dataNodePositions.map((node) => (
                <foreignObject key={node.id} x={node.x - 50} y={node.y - 50} width="100" height="100">
                    <div className="flex flex-col items-center justify-center group">
                        {/* Connection Point Visual */}
                        <div className="w-2 h-2 bg-slate-500 rounded-full mb-1 opacity-50"></div>
                        
                        <div className={`w-14 h-14 rounded-lg bg-slate-800 border-2 ${node.status === 'active' ? 'border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.3)]' : 'border-red-500'} flex items-center justify-center mb-2 transition-all duration-300 group-hover:scale-110`}>
                            <Database className={`w-7 h-7 ${node.status === 'active' ? 'text-emerald-400' : 'text-red-400'}`} />
                        </div>
                        <span className="text-slate-300 font-mono text-[10px] bg-slate-900/90 px-2 py-0.5 rounded whitespace-nowrap border border-slate-700">
                            {node.id}
                        </span>
                        <div className="flex items-center gap-1 mt-1">
                             <span className={`w-1.5 h-1.5 rounded-full ${node.status === 'active' ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}></span>
                             <span className="text-[9px] text-slate-500">H:{node.height}</span>
                        </div>
                    </div>
                </foreignObject>
            ))}

        </svg>
      </div>
    </div>
  );
};

export default TopologyGraph;
