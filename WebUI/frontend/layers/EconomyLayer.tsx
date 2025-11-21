
import React, { useState } from 'react';
import { UserAccount, SystemAccount } from '../types';
import { Wallet, Plus, ShieldCheck, Key, History, Trash2, Server, Coins, ChevronDown, ChevronUp, Copy, AlertTriangle, Eye } from 'lucide-react';
import { Card, Modal, ModalHeader, PageHeader, Button, TableStyles, Badge } from '../components/Shared';

interface EconomyLayerProps {
    users: UserAccount[];
    systemAccounts: SystemAccount[];
    onCreateUser: () => void;
    onDeleteUser: (id: string) => void;
    onFaucet: (id: string) => void;
}

/**
 * Economy Layer
 * 
 * ブロックチェーン上の経済圏（トークン残高）を管理する画面。
 * ウォレットのようなUIを目指し、アカウントカードや送金操作を直感的に行えるようにしています。
 */
const EconomyLayer: React.FC<EconomyLayerProps> = ({ users, systemAccounts, onCreateUser, onDeleteUser, onFaucet }) => {
  const [watchdogEnabled, setWatchdogEnabled] = useState(true);
  const [isSystemExpanded, setIsSystemExpanded] = useState(false); // デフォルトで閉じる
  const [viewPrivateKeyUser, setViewPrivateKeyUser] = useState<UserAccount | null>(null);
  
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const confirmDelete = () => {
      if (deleteConfirmId) {
          onDeleteUser(deleteConfirmId);
          setDeleteConfirmId(null);
      }
  };

  return (
    <div className="space-y-8 pb-20">
        {/* Header */}
        <PageHeader 
            title="Economy Management" 
            description="ユーザーアカウントの発行、Faucet（資金供給）、システムアカウントの管理" 
            icon={Coins}
            iconColor="text-yellow-500"
            action={
                <Button onClick={onCreateUser} icon={Plus} variant="primary" className="shadow-lg shadow-blue-200">
                    新規アカウント作成
                </Button>
            }
        />

        {/* Private Key Modal */}
        <Modal isOpen={!!viewPrivateKeyUser} onClose={() => setViewPrivateKeyUser(null)} className="w-full max-w-lg">
             <ModalHeader title="Private Key / Mnemonic" icon={Key} iconColor="text-orange-500" onClose={() => setViewPrivateKeyUser(null)} />
             <div className="p-6 pt-0">
                 <div className="mb-6">
                     <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Target Address</div>
                     <div className="font-mono text-xs bg-slate-100 p-3 rounded-xl break-all border border-slate-200 text-slate-600">{viewPrivateKeyUser?.address}</div>
                 </div>
                 <div className="bg-slate-900 rounded-2xl p-6 border border-slate-700 relative group shadow-inner">
                     <div className="font-mono text-emerald-400 text-sm leading-relaxed break-words filter blur-[3px] group-hover:blur-0 transition-all duration-500 select-all">
                        witch collapse practice feed shame open despair creek road again ice least monster budget hero
                     </div>
                     <div className="absolute top-3 right-3 opacity-50 group-hover:opacity-100 transition-opacity">
                         <button className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-colors" onClick={() => navigator.clipboard.writeText("witch collapse practice feed shame open despair creek road again ice least monster budget hero")}><Copy className="w-4 h-4" /></button>
                     </div>
                     <div className="absolute inset-0 flex items-center justify-center pointer-events-none group-hover:opacity-0 transition-opacity duration-300">
                         <div className="flex items-center gap-2 text-slate-500 text-xs font-bold bg-slate-800/80 px-3 py-1 rounded-full border border-slate-700 backdrop-blur">
                             <Eye className="w-3 h-3" /> Hover to reveal
                         </div>
                     </div>
                 </div>
                 <div className="mt-8 flex justify-end">
                     <Button variant="secondary" onClick={() => setViewPrivateKeyUser(null)}>閉じる</Button>
                 </div>
             </div>
        </Modal>

        {/* Delete Confirmation Modal */}
        <Modal isOpen={!!deleteConfirmId} onClose={() => setDeleteConfirmId(null)} className="max-w-sm w-full p-8 text-center">
            <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-6">
                <Trash2 className="w-8 h-8 text-red-500" />
            </div>
            <h3 className="text-xl font-bold text-slate-800 mb-2">アカウント削除</h3>
            <p className="text-sm text-slate-500 mb-8 leading-relaxed px-2">
                このアカウントに関連する残高情報は失われます。<br/>本当によろしいですか？
            </p>
            <div className="flex gap-4 justify-center">
                <Button variant="secondary" onClick={() => setDeleteConfirmId(null)}>キャンセル</Button>
                <Button variant="danger" onClick={confirmDelete}>削除する</Button>
            </div>
        </Modal>

        {/* Top Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="p-6 bg-gradient-to-br from-white to-blue-50/50 border-blue-100 lg:col-span-1 h-full">
                 <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3 text-slate-700">
                        <div className="p-2 bg-white rounded-lg shadow-sm border border-blue-100 text-blue-500"><ShieldCheck className="w-5 h-5" /></div>
                        <span className="font-bold text-sm">Relayer Watchdog</span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" checked={watchdogEnabled} onChange={() => setWatchdogEnabled(!watchdogEnabled)} className="sr-only peer" />
                        <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500 shadow-inner"></div>
                    </label>
                </div>
                <div className="text-xs text-slate-500 leading-relaxed font-medium mt-4">
                    {watchdogEnabled ? 
                        <span className="text-emerald-600 flex items-center gap-1"><div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" /> 監視中: 残高不足時に自動でFaucetを実行します。</span> : 
                        <span className="text-slate-400">機能停止中: ガス欠により停止するリスクがあります。</span>
                    }
                </div>
            </Card>

             <Card className="p-6 flex flex-col bg-slate-50/80 lg:col-span-2 h-full">
                 <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2 mb-4"><History className="w-4 h-4" />Watchdog Activity</h4>
                 <div className="space-y-3 overflow-y-auto h-24 custom-scrollbar pr-2">
                    <div className="text-[10px] font-mono text-slate-600 bg-white p-2 rounded-lg border border-slate-200 shadow-sm flex items-start gap-2">
                        <span className="text-emerald-500 mt-0.5">➜</span>
                        <span>[10:42] Relayer (Chain-0) low balance. Auto-faucet executed (+100 TKN).</span>
                    </div>
                    <div className="text-[10px] font-mono text-slate-600 bg-white p-2 rounded-lg border border-slate-200 shadow-sm flex items-start gap-2">
                        <span className="text-slate-400 mt-0.5">➜</span>
                        <span>[10:30] Watchdog service started. Monitoring 5 relayers.</span>
                    </div>
                    <div className="text-[10px] font-mono text-slate-600 bg-white p-2 rounded-lg border border-slate-200 shadow-sm flex items-start gap-2">
                        <span className="text-slate-400 mt-0.5">➜</span>
                        <span>[09:15] System health check passed. All balances sufficient.</span>
                    </div>
                </div>
             </Card>
        </div>

        {/* Users List */}
        <div className="space-y-4">
            <h3 className="text-lg font-bold text-slate-800 px-2 flex items-center gap-2">
                <Wallet className="w-5 h-5 text-slate-400"/> User Wallets <Badge color="blue">{users.length}</Badge>
            </h3>
            
            <div className={TableStyles.Container}>
                <table className="w-full text-left">
                    <thead className={TableStyles.Header}>
                        <tr>
                            <th className="px-6 py-4">Account Info</th>
                            <th className="px-6 py-4 text-right">Balance</th>
                            <th className="px-6 py-4 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                        {users.map(user => (
                            <tr key={user.id} className={TableStyles.Row}>
                                <td className="px-6 py-4">
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-500 to-indigo-500 text-white flex items-center justify-center font-bold text-sm shadow-lg shadow-blue-200">
                                            {user.name ? user.name.charAt(0) : 'U'}
                                        </div>
                                        <div>
                                            <div className="font-bold text-slate-800 text-sm">{user.name || 'Unknown User'}</div>
                                            <div className="text-xs text-slate-400 font-mono flex items-center gap-1 mt-0.5 group cursor-pointer" onClick={() => setViewPrivateKeyUser(user)}>
                                                {user.address.substring(0, 24)}...
                                                <Key className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity text-orange-400" />
                                            </div>
                                        </div>
                                    </div>
                                </td>
                                <td className="px-6 py-4 text-right">
                                    <div className="font-mono font-bold text-slate-800 text-lg">{user.balance.toLocaleString()} <span className="text-xs text-slate-400 font-sans">TKN</span></div>
                                </td>
                                <td className="px-6 py-4 text-right">
                                    <div className="flex justify-end gap-2">
                                        <Button size="sm" variant="secondary" className="text-emerald-600 border-emerald-100 bg-emerald-50 hover:bg-emerald-100 hover:border-emerald-200" onClick={() => onFaucet(user.id)}>+ Faucet</Button>
                                        <Button size="sm" variant="ghost" className="text-slate-400 hover:text-red-500 hover:bg-red-50" onClick={() => setDeleteConfirmId(user.id)}><Trash2 className="w-4 h-4" /></Button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>

        {/* System Accounts List (Collapsible) */}
        <Card className="overflow-hidden border-slate-200 shadow-none bg-slate-50">
             <div className="px-6 py-4 flex justify-between items-center cursor-pointer hover:bg-slate-100 transition-colors select-none" onClick={() => setIsSystemExpanded(!isSystemExpanded)}>
                <h3 className="font-bold text-slate-600 flex items-center gap-2 text-sm uppercase tracking-wider"><Server className="w-4 h-4" /> System Accounts (Infra & Pool)</h3>
                {isSystemExpanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
            </div>
            {isSystemExpanded && (
                <div className="overflow-x-auto animate-in slide-in-from-top-2 duration-200 border-t border-slate-100 bg-white">
                    <table className="w-full text-left text-sm">
                        <thead className={TableStyles.Header}>
                            <tr><th className="px-6 py-3 whitespace-nowrap">Name / Role</th><th className="px-6 py-3 whitespace-nowrap">Address</th><th className="px-6 py-3 text-right whitespace-nowrap">Balance</th><th className="px-6 py-3 text-right whitespace-nowrap">Action</th></tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {systemAccounts.map(acc => (
                                <tr key={acc.id} className="hover:bg-slate-50 transition-colors">
                                    <td className="px-6 py-4 font-medium text-slate-700 flex items-center gap-2 whitespace-nowrap">
                                        {acc.type === 'faucet_source' ? <div className="p-1.5 bg-yellow-50 rounded text-yellow-500"><Coins className="w-4 h-4" /></div> : <div className="p-1.5 bg-slate-100 rounded text-slate-500"><Server className="w-4 h-4" /></div>}
                                        {acc.name}
                                    </td>
                                    <td className="px-6 py-4 font-mono text-slate-500 text-xs break-all max-w-xs">{acc.address}</td>
                                    <td className="px-6 py-4 text-right font-mono font-bold text-slate-800 whitespace-nowrap">{acc.balance.toLocaleString()}</td>
                                    <td className="px-6 py-4 text-right whitespace-nowrap">
                                        {acc.type !== 'faucet_source' ? (
                                            <Button size="sm" variant="secondary" className="text-xs py-1 h-auto" onClick={() => onFaucet(acc.id)}>Top up</Button>
                                        ) : <span className="text-xs text-slate-300 font-bold italic px-2">Global Pool</span>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </Card>
    </div>
  );
};

export default EconomyLayer;
