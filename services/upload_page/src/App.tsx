// src/App.tsx
import { useState } from 'react';
import { useKeplr } from './hooks/useKeplr';
import { useCsuUpload } from './hooks/useCsuUpload';
import { processFileList } from './lib/zip';
import { styles } from './styles/AppStyles';
import { CONFIG } from './constants/config';

/**
 * メインアプリケーションコンポーネント
 */
export default function App() {
  const { address, client, balance, connect, requestFaucet, updateBalance } = useKeplr();
  const { upload, isProcessing, uploadProgress, logs, addLog } = useCsuUpload(client, address);

  // プロジェクト設定の状態
  const [projectName, setProjectName] = useState('onchain-web-portal');
  const [projectVersion, setProjectVersion] = useState('1.0.0');
  // フラグメントサイズの追加 (デフォルト: 1024)
  const [fragmentSize, setFragmentSize] = useState(1024);
  const [files, setFiles] = useState<any[]>([]);

  // 表示用にugwcをGWCに変換するユーティリティ
  const formatBalance = (amount: string) => {
    return (parseInt(amount) / 1000000).toLocaleString(undefined, { minimumFractionDigits: 2 });
  };

  return (
    <div style={styles.container}>
      {/* ナビゲーション */}
      <nav style={styles.navbar}>
        <div style={styles.brand}>🌲 CRYPTOMERIA CORE</div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {address && (
            <>
              {/* アカウント残高表示領域 */}
              <div style={{ ...styles.addressBadge, background: '#1e293b', border: '1px solid #334155' }}>
                <span style={{ fontSize: '0.7rem', color: '#94a3b8', marginRight: '8px' }}>BALANCE</span>
                <strong style={{ color: '#f8fafc' }}>{formatBalance(balance)} {CONFIG.minDenom}</strong>
              </div>

              <button
                onClick={async () => {
                  addLog("🪙 Faucetからトークンの取得をリクエストしています...");
                  const prevBalStr = await updateBalance(address, client!);

                  const ok = await requestFaucet(address);
                  if (ok) {
                    addLog("⏳ ネットワークへの反映を待機中（約3秒）...");
                    setTimeout(async () => {
                      const newBalStr = await updateBalance(address, client!);
                      const diff = (parseInt(newBalStr || "0") - parseInt(prevBalStr || "0")) / 1000000;
                      addLog(`✅ トークン取得成功: +${diff} ${CONFIG.minDenom} を受領しました。`);
                      addLog(`現在の総残高: ${formatBalance(newBalStr || "0")} ${CONFIG.minDenom}`);
                    }, 3000);
                  } else {
                    addLog(`❌ Faucetサーバーに接続できませんでした。ポート${CONFIG.faucetEndpoint.split(':')[2]}が開放されているか確認してください。`);
                  }
                }}
                style={{ ...styles.btnPrimary, width: 'auto', padding: '8px 16px', fontSize: '0.8rem', backgroundColor: '#64748b' }}
              >
                🪙 トークン取得
              </button>
            </>
          )}
          {!address ? (
            <button onClick={connect} style={{ ...styles.btnPrimary, width: 'auto', padding: '8px 24px', fontSize: '0.9rem' }}>
              Keplrと接続
            </button>
          ) : (
            <div style={styles.addressBadge}>
              <span style={{ width: '8px', height: '8px', background: '#10b981', borderRadius: '50%' }}></span>
              <code>{address}</code>
            </div>
          )}
        </div>
      </nav>

      {/* メインレイアウト */}
      <main style={styles.main}>

        {/* 左側パネル */}
        <aside style={styles.sidebar}>
          <div style={styles.card}>
            <h3 style={styles.sectionTitle}>デプロイ設定</h3>

            {/* プロジェクトID入力 */}
            <div style={{ marginBottom: '15px' }}>
              <label style={styles.label}>プロジェクトID</label>
              <input
                type="text" value={projectName}
                onChange={e => setProjectName(e.target.value)}
                style={styles.input}
              />
            </div>

            {/* バージョン入力欄 */}
            <div style={{ marginBottom: '15px' }}>
              <label style={styles.label}>プロジェクトバージョン</label>
              <input
                type="text" value={projectVersion}
                onChange={e => setProjectVersion(e.target.value)}
                placeholder="1.0.0"
                style={styles.input}
              />
            </div>

            {/* フラグメントサイズ選択の追加 */}
            <div style={{ marginBottom: '20px' }}>
              <label style={styles.label}>フラグメントサイズ (Byte)</label>
              <select
                value={fragmentSize}
                onChange={e => setFragmentSize(Number(e.target.value))}
                style={{ ...styles.input, cursor: 'pointer' }}
              >
                <option value={512}>512 B (Small)</option>
                <option value={1024}>1 KB (Default)</option>
                <option value={10240}>10 KB</option>
                <option value={102400}>100 KB</option>
                <option value={512000}>500 KB</option>
                <option value={1048576}>1 MB</option>
                <option value={5242880}>5 MB</option>
                <option value={10485760}>10 MB (Large)</option>
              </select>
              <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '6px' }}>
                ※ サイズが小さいほど分散性が向上し、大きいほど処理速度が向上します。
              </div>
            </div>

            <h3 style={styles.sectionTitle}>フォルダアップロード</h3>
            <div style={styles.dropzone}>
              <input
                type="file"
                // @ts-ignore
                webkitdirectory="" directory="" multiple
                onChange={async e => setFiles(await processFileList(e.target.files!))}
                style={styles.hiddenInput}
              />
              <div style={{ color: files.length > 0 ? '#10b981' : '#94a3b8', fontWeight: 600 }}>
                {files.length > 0 ? `📂 ${files.length} ファイル準備完了` : "デプロイするフォルダを選択してください"}
              </div>
            </div>
          </div>

          <button
            // ここで fragmentSize を渡す
            onClick={() => upload(files, projectName, projectVersion, fragmentSize)}
            disabled={!address || files.length === 0 || isProcessing}
            style={{
              ...styles.btnPrimary,
              backgroundColor: isProcessing ? '#cbd5e1' : '#2563eb'
            }}
          >
            {isProcessing ? `デプロイ実行中... ${Math.round(uploadProgress)}%` : '🚀 ネットワークに公開する'}
          </button>
        </aside>

        {/* 右側コンソール */}
        <section style={styles.consoleContainer}>
          <div style={styles.consoleHeader}>
            <span>NETWORK CONSOLE</span>
            <span>NODE ACTIVE</span>
          </div>
          <div style={styles.consoleBody}>
            {logs.map((log, i) => (
              <div key={i} style={{ marginBottom: '6px' }}>
                <span style={{ color: '#334155', marginRight: '10px' }}>$</span>{log}
              </div>
            ))}
            {logs.length === 0 && <div style={{ color: '#334155' }}>接続を待機しています...</div>}
            <div ref={(el) => el?.scrollIntoView({ behavior: 'smooth' })}></div>
          </div>
          {isProcessing && (
            <div style={{ height: '4px', background: '#1e293b' }}>
              <div style={{ height: '100%', background: '#2563eb', width: `${uploadProgress}%`, transition: 'width 0.3s' }}></div>
            </div>
          )}
        </section>

      </main>
    </div>
  );
}