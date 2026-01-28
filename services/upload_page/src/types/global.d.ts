// services/upload_page/src/types/global.d.ts
export { };

declare global {
    interface Window {
        keplr?: {
            enable: (chainId: string) => Promise<void>;
            getOfflineSigner: (chainId: string) => any;
            getOfflineSignerOnlyAmino: (chainId: string) => any;
            getOfflineSignerAuto: (chainId: string) => Promise<any>;
            experimentalSuggestChain: (chainInfo: any) => Promise<void>;
        };
        // Keplrがインジェクトされるとwindow.getOfflineSignerも使えるようになる場合がありますが、
        // 基本的には window.keplr を経由します。
        getOfflineSigner?: (chainId: string) => any;
    }
}