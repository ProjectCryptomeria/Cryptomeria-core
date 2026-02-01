/**
 * 実験用共通設定
 */
export const CONFIG = {
// ポートフォワードされたローカルポートを使用
  GWC_RPC: "http://localhost:30007",
  GWC_API: "http://localhost:30003",
  RENDER_URL: "http://localhost:30003/render",
  CHAIN_ID: "gwc",
  DENOM: "uatom",
  BIN: {
    GWC: "/workspace/apps/gwc/dist/gwcd",
  },
  NAMESPACE: "cryptomeria",
};