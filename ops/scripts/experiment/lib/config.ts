/**
 * 実験用共通設定
 */
export const CONFIG = {
// ポートフォワードされたローカルポートを使用
  GWC_RPC: "http://localhost:30007",
  GWC_API: "http://localhost:30003",
  RENDER_URL: "http://localhost:30003/render",
  CHAIN_ID: "gwc-1",
  DENOM: "ucrypt",
  BIN: {
    GWC: "/workspace/apps/gwc/dist/gwcd",
  },
  NAMESPACE: "cryptomeria",
};