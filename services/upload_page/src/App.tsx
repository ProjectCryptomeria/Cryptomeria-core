// src/App.tsx
import { useState } from 'react';
import { useKeplr } from './hooks/useKeplr';
import { useCsuUpload } from './hooks/useCsuUpload';
import { processFileList } from './lib/zip';
import { styles } from './styles/AppStyles';
import { CONFIG } from './constants/config';

export default function App() {
  const { address, client, balance, connect, requestFaucet, updateBalance } = useKeplr();
  const { upload, isProcessing, uploadProgress, logs, addLog } = useCsuUpload(client, address);

  const [projectName, setProjectName] = useState('onchain-web-portal');
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
                    // チェーンの反映を待ってから残高を更新
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
            <div style={{ marginBottom: '20px' }}>
              <label style={styles.label}>プロジェクトID</label>
              <input
                type="text" value={projectName}
                onChange={e => setProjectName(e.target.value)}
                style={styles.input}
              />
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
            onClick={() => upload(files, projectName, '1.0.0')}
            disabled={!address || files.length === 0 || isProcessing}
            style={{
              ...styles.btnPrimary,
              backgroundColor: isProcessing ? '#cbd5e1' : '#2563eb'
            }}
          >
            {isProcessing ? `デプロイ実行中... ${uploadProgress}%` : '🚀 ネットワークに公開する'}
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