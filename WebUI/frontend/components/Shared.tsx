import React, { useEffect, useRef } from 'react';
import { X, CheckCircle, AlertTriangle, Loader2, Terminal, Info } from 'lucide-react';

/**
 * Shared Components Library
 * 
 * アプリケーション全体でデザインと振る舞いを統一するための再利用可能なコンポーネント群です。
 * ExperimentLayerのデザイン（丸みを帯びたカード、ソフトな影、リッチなインタラクション）を基準にしています。
 */

// --- Types ---
type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline';
type ButtonSize = 'sm' | 'md' | 'lg';

// --- Button Component ---
/**
 * 統一されたデザインを持つボタンコンポーネント
 * 
 * @why: アプリケーション全体でボタンの形状、色、ホバー効果を一貫させるため。
 * HTMLのbutton要素をラップし、variant(種類)とsize(大きさ)でスタイルを制御します。
 */
export const Button: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { 
  variant?: ButtonVariant; 
  size?: ButtonSize; 
  isLoading?: boolean;
  icon?: React.ElementType;
}> = ({ 
  children, 
  className = '', 
  variant = 'primary', 
  size = 'md', 
  isLoading = false, 
  icon: Icon,
  disabled,
  ...props 
}) => {
  // ベーススタイル: フレックス配置、丸み、トランジション、フォーカス時のリング
  const baseStyle = "inline-flex items-center justify-center font-bold transition-all duration-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95";
  
  // サイズ別スタイル
  const sizeStyles = {
    sm: "px-3 py-1.5 text-xs",
    md: "px-5 py-2.5 text-sm",
    lg: "px-8 py-4 text-lg",
  };

  // バリエーション別スタイル (ExperimentLayerのスタイルに準拠)
  const variantStyles = {
    primary: "bg-primary-indigo text-white hover:bg-indigo-700 shadow-md shadow-indigo-200 hover:shadow-lg",
    secondary: "bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 shadow-sm",
    danger: "bg-white text-red-600 border border-red-200 hover:bg-red-50 hover:border-red-300 shadow-sm",
    ghost: "bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900",
    outline: "bg-transparent border-2 border-slate-200 text-slate-600 hover:border-primary-indigo hover:text-primary-indigo",
  };

  return (
    <button 
      className={`${baseStyle} ${sizeStyles[size]} ${variantStyles[variant]} ${className}`} 
      disabled={disabled || isLoading}
      {...props}
    >
      {isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
      {!isLoading && Icon && <Icon className={`w-4 h-4 ${children ? 'mr-2' : ''}`} />}
      {children}
    </button>
  );
};

// --- Card Component ---
/**
 * カードコンポーネント
 * 
 * @why: コンテンツをグループ化し、視覚的な階層構造を作るため。
 * ExperimentLayerに合わせて rounded-3xl と柔らかい影を採用しています。
 */
export const Card: React.FC<{ children: React.ReactNode; className?: string; onClick?: () => void }> = ({ children, className = '', onClick }) => (
  <div 
    onClick={onClick} 
    className={`
      bg-white rounded-3xl shadow-sm border border-slate-100 
      ${className} 
      ${onClick ? 'cursor-pointer transition-all duration-300 hover:shadow-md hover:-translate-y-1' : ''}
    `}
  >
    {children}
  </div>
);

// --- Page Header Component ---
/**
 * ページヘッダーコンポーネント
 * 
 * @why: 各レイヤー（画面）のトップに表示するタイトルとアイコンを統一するため。
 * ユーザーに「今どの機能を使っているか」を明確に伝えます。
 */
export const PageHeader: React.FC<{ 
  title: string; 
  description?: string; 
  icon: React.ElementType; 
  iconColor?: string;
  action?: React.ReactNode;
}> = ({ title, description, icon: Icon, iconColor = "text-primary-indigo", action }) => (
  <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6 animate-in fade-in slide-in-from-top-5 duration-500">
    <div className="flex items-center gap-4">
      <div className={`p-3 rounded-2xl bg-white shadow-sm border border-slate-100 ${iconColor}`}>
        <Icon className="w-8 h-8" />
      </div>
      <div>
        <h2 className="text-2xl font-bold text-slate-800 tracking-tight">{title}</h2>
        {description && <p className="text-slate-500 text-sm font-medium mt-0.5">{description}</p>}
      </div>
    </div>
    {action && <div>{action}</div>}
  </div>
);

// --- Input Component ---
/**
 * テキスト入力フィールド
 * 
 * @why: フォーム要素のデザインを統一し、フォーカス時のリングや色を一貫させるため。
 */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className = '', ...props }, ref) => (
  <input
    ref={ref}
    className={`
      block w-full rounded-xl border-slate-200 bg-slate-50 p-3 
      text-sm font-medium text-slate-800 placeholder:text-slate-400
      focus:border-primary-indigo focus:bg-white focus:ring-2 focus:ring-primary-indigo/20 
      outline-none transition-all shadow-sm
      ${className}
    `}
    {...props}
  />
));

// --- Modal Component ---
/**
 * モーダルダイアログ
 * 
 * @why: ユーザーの注意を引き、重要な操作や詳細情報の表示を行うため。
 * 背景のブラー効果と、ズームインアニメーションでモダンな印象を与えます。
 */
export const Modal: React.FC<{ isOpen: boolean; onClose: () => void; children: React.ReactNode; className?: string }> = ({ isOpen, onClose, children, className = '' }) => {
  if (!isOpen) return null;
  
  return (
    // 背景: backdrop-blur で背後のコンテンツをぼかし、フォーカスをモーダルに合わせる
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4 transition-all" onClick={onClose}>
      {/* 本体: クリックイベントの伝播を止める(e.stopPropagation)ことで、背景クリックでのみ閉じるようにする */}
      <div 
        className={`bg-white rounded-3xl shadow-2xl ring-1 ring-black/5 animate-in zoom-in-95 duration-300 ${className}`} 
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};

export const ModalHeader: React.FC<{ title: string; subTitle?: string; icon?: React.ElementType; onClose: () => void; iconColor?: string }> = ({ title, subTitle, icon: Icon, onClose, iconColor = "text-slate-800" }) => (
  <div className="px-6 py-5 border-b border-slate-100 flex justify-between items-center bg-white rounded-t-3xl">
    <div className="flex items-center gap-3">
       {Icon && <div className={`p-2 bg-slate-50 rounded-xl ${iconColor}`}><Icon className="w-5 h-5" /></div>}
       <div>
         <div className="text-lg font-bold text-slate-800">{title}</div>
         {subTitle && <div className="text-xs text-slate-500 font-mono">{subTitle}</div>}
       </div>
    </div>
    <button onClick={onClose} className="w-8 h-8 rounded-full bg-slate-50 hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors">
      <X className="w-4 h-4" />
    </button>
  </div>
);

// --- Badge Component ---
/**
 * バッジコンポーネント
 * 
 * @why: ステータスやカテゴリーなどのメタ情報を視覚的に強調するため。
 */
export const Badge: React.FC<{ children: React.ReactNode; color?: 'slate' | 'blue' | 'green' | 'red' | 'yellow' | 'indigo' | 'purple'; className?: string }> = ({ children, color = 'slate', className = '' }) => {
  const colors = {
    slate: 'bg-slate-100 text-slate-600 border-slate-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-100',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    red: 'bg-red-50 text-red-700 border-red-100',
    yellow: 'bg-yellow-50 text-yellow-700 border-yellow-100',
    indigo: 'bg-indigo-50 text-indigo-700 border-indigo-100',
    purple: 'bg-purple-50 text-purple-700 border-purple-100',
  };
  return (
    <span className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border uppercase tracking-wide ${colors[color]} ${className}`}>
      {children}
    </span>
  );
};

// ステータスに応じたバッジを自動選択するラッパー
export const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  let color: 'green' | 'red' | 'yellow' | 'slate' = 'slate';
  let icon = null;
  
  if (['active', 'SUCCESS', 'COMPLETE', 'READY'].includes(status)) {
    color = 'green';
    icon = <CheckCircle className="w-3 h-3 mr-1.5" />;
  } else if (['error', 'FAILED', 'FAIL', 'ABORTED'].includes(status)) {
    color = 'red';
    icon = <AlertTriangle className="w-3 h-3 mr-1.5" />;
  } else if (['RUNNING', 'PENDING', 'CALCULATING'].includes(status)) {
    color = 'yellow';
    icon = <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />;
  }

  return (
    <Badge color={color} className="inline-flex items-center pl-2 pr-3 py-1.5">
      {icon}
      {status}
    </Badge>
  );
};

// --- Log Viewer Component ---
/**
 * ログ表示コンポーネント
 * 
 * @why: システムログやビルドログを「ターミナル風」に表示し、開発者ツールらしさを演出するため。
 * 自動スクロール機能を持ちます。
 */
export const LogViewer: React.FC<{ logs: string[]; className?: string; title?: string }> = ({ logs, className = '', title }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  
  // ログが更新されるたびに最下部へスクロール (scrollToを使用)
  useEffect(() => { 
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth"
      });
    }
  }, [logs]);

  return (
    <div className={`flex flex-col bg-slate-900 rounded-3xl overflow-hidden shadow-2xl border border-slate-700 font-mono ${className}`}>
      {/* Terminal Header */}
      <div className="bg-slate-800/50 px-4 py-3 flex items-center justify-between border-b border-white/5 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="p-1.5 bg-white/10 rounded-md">
            <Terminal className="w-3 h-3 text-slate-300" />
          </div>
          <span className="text-xs font-bold text-slate-300 tracking-wider uppercase opacity-80">{title || 'System Output'}</span>
        </div>
        <div className="flex gap-2">
          <div className="w-3 h-3 rounded-full bg-red-500/80 border border-red-600/50 shadow-inner" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/80 border border-yellow-600/50 shadow-inner" />
          <div className="w-3 h-3 rounded-full bg-emerald-500/80 border border-emerald-600/50 shadow-inner" />
        </div>
      </div>
      
      {/* Log Content */}
      <div ref={scrollRef} className="flex-1 p-6 text-xs md:text-sm overflow-y-auto custom-scrollbar text-slate-300 leading-relaxed space-y-1.5">
        {logs.length === 0 && <div className="text-slate-600 italic flex items-center gap-2"><Info className="w-4 h-4"/> Waiting for logs...</div>}
        {logs.map((log, i) => (
          <div key={i} className="break-all animate-in fade-in slide-in-from-left-2 duration-200 flex">
            <span className="text-emerald-500 mr-3 select-none opacity-50">➜</span>
            <span>{log}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// --- SlideOver Component ---
/**
 * スライドオーバー（ドロワー）コンポーネント
 * 
 * @why: 画面遷移せずに詳細情報を表示するため。メインのコンテキストを維持したまま作業できます。
 */
export const SlideOver: React.FC<{ isOpen: boolean; title: string; onClose?: () => void; children: React.ReactNode; width?: string }> = ({ isOpen, title, onClose, children, width = "w-96" }) => (
  <>
    {/* Overlay for closing */}
    {isOpen && <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-[2px] z-40 transition-opacity" onClick={onClose}></div>}
    
    <div className={`fixed right-0 top-0 bottom-0 ${width} bg-white shadow-2xl transition-transform duration-300 ease-in-out z-50 flex flex-col border-l border-slate-100 ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="p-6 border-b border-slate-100 bg-white flex justify-between items-center shrink-0 z-10">
          <h3 className="font-bold text-xl text-slate-800 tracking-tight">{title}</h3>
          {onClose && (
            <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar bg-slate-50/50">
          {children}
        </div>
    </div>
  </>
);

// --- Table Helper ---
/**
 * テーブルの共通スタイル定数
 * @why: 各レイヤーでテーブルのclassを毎回書くのを防ぎ、スタイル変更を一括で行えるようにするため。
 */
export const TableStyles = {
    Container: "overflow-hidden rounded-2xl border border-slate-100 shadow-sm bg-white",
    Header: "bg-slate-50/80 backdrop-blur text-slate-500 font-bold text-xs uppercase tracking-wider border-b border-slate-100",
    Cell: "px-6 py-4 text-sm border-b border-slate-50 last:border-0",
    Row: "hover:bg-slate-50/80 transition-colors duration-200",
};