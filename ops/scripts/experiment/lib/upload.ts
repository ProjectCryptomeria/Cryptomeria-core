import { runCmd } from "./common.ts";
import { CONFIG } from "./config.ts";

/**
 * アップロード共通処理 (gwcd tx gateway ...)
 */
export async function uploadToGwc(filePath: string, fragSize: string) {
  // システムのトランザクション実行
  const output = await runCmd([
    CONFIG.BIN.GWC, "tx", "gateway", "upload", filePath,
    "--from", "alice",
    "--chain-id", CONFIG.CHAIN_ID,
    "--fragment-size", fragSize,
    "--yes", "--output", "json"
  ]);
  
  const txRes = JSON.parse(output);
  return {
    txHash: txRes.txhash,
    gasUsed: parseInt(txRes.gas_used),
  };
}