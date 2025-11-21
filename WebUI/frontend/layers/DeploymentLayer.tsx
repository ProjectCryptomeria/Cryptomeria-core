import React, { useState } from 'react';
import { Play, Trash2, Layers, CheckCircle2, Server, AlertTriangle, Activity } from 'lucide-react';
import { Card, LogViewer, Badge, Modal, PageHeader, Button } from '../components/Shared';
import { useDeploymentControl } from '../hooks';

interface DeploymentLayerProps {
    setDeployedNodeCount: (count: number) => void;
    deployedNodeCount: number;
    setIsDockerBuilt: (isBuilt: boolean) => void;
    isDockerBuilt: boolean;
}

/**
 * Deployment Layer
 * 
 * クラスタへのデプロイ操作を行う管理画面。
 * 破壊的な操作（リセット）や長時間かかる処理（ビルド）があるため、
 * モーダルによる確認やログ表示によってプロセスの可視化を重視しています。
 */
const DeploymentLayer: React.FC<DeploymentLayerProps> = ({ setDeployedNodeCount, deployedNodeCount, setIsDockerBuilt, isDockerBuilt }) => {
  // Custom Hook
  const { scaleCount, setScaleCount, isBuilding, isDeploying, logs, handleBuild, handleDeploy, handleReset: controlReset } = useDeploymentControl(deployedNodeCount, setDeployedNodeCount, setIsDockerBuilt);
  
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const handleResetClick = () => {
      setShowResetConfirm(true);
  };

  const confirmReset = () => {
      controlReset();
      setShowResetConfirm(false);
  };

  return (
    <div className="h-full flex flex-col pb-10">
        {/* Reset Confirmation Modal */}
        <Modal isOpen={showResetConfirm} onClose={() => setShowResetConfirm(false)} className="max-w-sm w-full p-8 text-center">
            <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-6 animate-pulse">
                <AlertTriangle className="w-8 h-8 text-red-500" />
            </div>
            <h3 className="text-xl font-bold text-slate-800 mb-2">環境を全削除しますか？</h3>
            <p className="text-sm text-slate-500 mb-8 leading-relaxed px-4">
                PVCを含むすべてのデータが破棄されます。<br/>この操作は取り消せません。
            </p>
            <div className="flex gap-4 justify-center">
                <Button variant="secondary" onClick={() => setShowResetConfirm(false)}>キャンセル</Button>
                <Button variant="danger" onClick={confirmReset} icon={Trash2}>リセット実行</Button>
            </div>
        </Modal>

      <PageHeader 
        title="Infrastructure Deployment" 
        description="DockerイメージのビルドとKubernetesクラスタへのデプロイ管理" 
        icon={Server} 
        iconColor="text-indigo-500"
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 flex-1 min-h-0">
        
        {/* Controls Section */}
        <div className="space-y-8 overflow-y-auto custom-scrollbar pr-2">
            
            {/* Status Widget */}
            <div className="bg-slate-800 p-5 rounded-3xl border border-slate-700 shadow-lg relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                    <Activity className="w-24 h-24 text-white" />
                </div>
                <div className="relative z-10">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="w-10 h-10 bg-emerald-500/20 rounded-xl flex items-center justify-center border border-emerald-500/30">
                            <CheckCircle2 className="w-6 h-6 text-emerald-400" />
                        </div>
                        <div>
                            <h4 className="text-base font-bold text-slate-200">System Healthy</h4>
                            <div className="text-xs text-emerald-400 flex items-center gap-2">
                                <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></span>Connected to K8s
                            </div>
                        </div>
                    </div>
                    <div className="text-[10px] font-mono text-slate-400 bg-slate-900/50 p-3 rounded-xl border border-slate-700/50 mt-2">
                         <div className="flex justify-between"><span>Context:</span> <span className="text-slate-200">minikube</span></div>
                         <div className="flex justify-between"><span>Namespace:</span> <span className="text-slate-200">default</span></div>
                    </div>
                </div>
            </div>

            <Card className="p-6">
                <div className="flex items-center gap-3 mb-6">
                    <div className="p-2.5 bg-indigo-50 text-indigo-600 rounded-xl"><Layers className="w-5 h-5" /></div>
                    <h3 className="text-lg font-bold text-slate-800">Build Image</h3>
                </div>
                <div className="space-y-6">
                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Target Components</label>
                        <div className="flex gap-3 flex-wrap">
                            {['DataChain', 'MetaChain', 'Relayer'].map(t => (
                                <label key={t} className="flex items-center gap-2 px-4 py-2.5 border border-slate-200 rounded-xl cursor-pointer hover:bg-slate-50 hover:border-indigo-200 transition-all">
                                    <input type="checkbox" defaultChecked className="w-4 h-4 accent-indigo-600 rounded" />
                                    <span className="text-sm font-bold text-slate-700">{t}</span>
                                </label>
                            ))}
                        </div>
                    </div>
                    
                    <Button 
                        onClick={handleBuild} 
                        isLoading={isBuilding} 
                        className="w-full" 
                        variant="primary"
                        icon={Play}
                    >
                        Dockerイメージ作成
                    </Button>
                    
                    {isDockerBuilt && (
                        <div className="animate-in fade-in slide-in-from-top-2">
                            <Badge color="green" className="w-full flex items-center justify-center py-2 text-xs">
                                <CheckCircle2 className="w-3 h-3 mr-1.5" /> Built: raidchain/node:latest
                            </Badge>
                        </div>
                    )}
                </div>
            </Card>

            <Card className="p-6">
                <div className="flex items-center gap-3 mb-6">
                    <div className="p-2.5 bg-emerald-50 text-emerald-600 rounded-xl"><Server className="w-5 h-5" /></div>
                    <h3 className="text-lg font-bold text-slate-800">Cluster Scale</h3>
                </div>
                <div className="space-y-8">
                    <div>
                        <div className="flex justify-between mb-4">
                            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Replica Count</label>
                            <span className="text-base font-mono font-bold text-emerald-600 bg-emerald-50 px-3 py-1 rounded-lg border border-emerald-100">{scaleCount} Nodes</span>
                        </div>
                        <input 
                            type="range" 
                            min="1" 
                            max="10" 
                            step="1" 
                            value={scaleCount} 
                            onChange={(e) => setScaleCount(Number(e.target.value))} 
                            className="w-full h-3 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-emerald-500 hover:accent-emerald-400 transition-all" 
                        />
                        <div className="flex justify-between text-[10px] text-slate-400 mt-2 font-mono"><span>MIN: 1</span><span>MAX: 10</span></div>
                    </div>

                    {!isDockerBuilt && (
                        <div className="text-xs bg-orange-50 text-orange-600 p-4 rounded-2xl border border-orange-100 flex items-start gap-3">
                            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" /> 
                            <span className="font-medium">デプロイする前にDockerイメージをビルドする必要があります。</span>
                        </div>
                    )}

                    <div className="flex flex-col gap-3">
                        <Button 
                            onClick={handleDeploy} 
                            disabled={isDeploying || isBuilding || !isDockerBuilt} 
                            isLoading={isDeploying}
                            className="w-full bg-emerald-600 hover:bg-emerald-700 shadow-emerald-200"
                            variant="primary"
                        >
                            Helm Upgrade (Apply)
                        </Button>
                        <Button onClick={handleResetClick} variant="danger" className="w-full" icon={Trash2}>
                            環境をリセット
                        </Button>
                    </div>
                </div>
            </Card>
        </div>

        {/* Log Viewer Section */}
        <div className="lg:col-span-2 h-full min-h-[400px]">
             <LogViewer logs={logs} title="webui-controller-terminal" className="h-full" />
        </div>
      </div>
    </div>
  );
};

export default DeploymentLayer;