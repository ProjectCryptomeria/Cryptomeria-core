// src/styles/AppStyles.ts
import { type CSSProperties } from 'react';

export const styles: { [key: string]: CSSProperties } = {
    container: {
        width: '100vw',
        minHeight: '100vh',
        backgroundColor: '#f8fafc',
        color: '#1e293b',
        fontFamily: '"Inter", "system-ui", sans-serif',
        display: 'flex',
        flexDirection: 'column',
        margin: 0,
        padding: 0,
        overflowX: 'hidden',
    },
    navbar: {
        position: 'relative',
        zIndex: 100, // 他の要素より前面に
        height: '72px',
        padding: '0 40px',
        backgroundColor: '#ffffff',
        borderBottom: '1px solid #e2e8f0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
    },
    brand: {
        fontSize: '1.4rem',
        fontWeight: 800,
        color: '#2563eb',
        letterSpacing: '-0.5px',
    },
    main: {
        display: 'grid',
        gridTemplateColumns: '420px 1fr', // 操作パネルを固定、残りをコンソール
        gap: '32px',
        padding: '32px 40px',
        flex: 1,
        boxSizing: 'border-box',
        width: '100%',
        alignItems: 'start', // 上揃えにする（Sticky用）
    },
    sidebar: {
        display: 'flex',
        flexDirection: 'column',
        gap: '24px',
    },
    card: {
        backgroundColor: '#ffffff',
        borderRadius: '16px',
        padding: '24px',
        border: '1px solid #e2e8f0',
        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)',
    },
    label: {
        display: 'block',
        fontSize: '0.85rem',
        fontWeight: 700,
        color: '#64748b',
        marginBottom: '8px',
    },
    input: {
        width: '100%',
        padding: '12px 16px',
        backgroundColor: '#f1f5f9',
        border: '1px solid #cbd5e1',
        borderRadius: '8px',
        fontSize: '1rem',
        boxSizing: 'border-box',
        color: '#1e293b',
    },
    dropzone: {
        position: 'relative', // inputの基準点
        border: '2px dashed #cbd5e1',
        borderRadius: '12px',
        padding: '40px 20px',
        textAlign: 'center',
        backgroundColor: '#f8fafc',
        overflow: 'hidden',
    },
    hiddenInput: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        opacity: 0,
        cursor: 'pointer',
        zIndex: 5,
    },
    btnPrimary: {
        width: '100%',
        padding: '18px',
        backgroundColor: '#2563eb',
        color: '#ffffff',
        border: 'none',
        borderRadius: '12px',
        fontWeight: 700,
        fontSize: '1.1rem',
        cursor: 'pointer',
        transition: 'all 0.2s',
    },
    consoleContainer: {
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#0f172a', // コンソールのみダーク
        borderRadius: '16px',
        overflow: 'hidden',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2)',

        // Sticky設定と高さ固定
        position: 'sticky',
        top: '32px', // 上部の余白
        height: 'calc(100vh - 200px)', // ビューポート高さからナビバーと余白を引く
    },
    consoleHeader: {
        padding: '12px 24px',
        backgroundColor: '#1e293b',
        color: '#94a3b8',
        fontSize: '0.75rem',
        fontWeight: 700,
        display: 'flex',
        justifyContent: 'space-between',
        flexShrink: 0, // ヘッダーが縮まないように
    },
    consoleBody: {
        flex: 1,
        padding: '24px',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: '0.9rem',
        color: '#10b981',
        overflowY: 'auto', // ここでスクロールさせる
        lineHeight: '1.6',
    },
    addressBadge: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 16px',
        backgroundColor: '#f1f5f9',
        borderRadius: '99px',
        fontSize: '0.85rem',
        fontWeight: 600,
        border: '1px solid #e2e8f0',
    },
};