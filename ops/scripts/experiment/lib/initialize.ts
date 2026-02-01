import { runCmd, log } from "./common.ts";
import { CONFIG } from "./config.ts";

/**
 * 実験アカウント「alice」の準備
 */
export async function setupAlice() {
  log("Setting up local account 'alice'...");
  try {
    // 既存のaliceを削除(クリーンアップ)
    await runCmd([CONFIG.BIN.GWC, "keys", "delete", "alice", "--yes"]);
  } catch { /* ignore */ }

  const output = await runCmd([CONFIG.BIN.GWC, "keys", "add", "alice", "--output", "json"]);
  const account = JSON.parse(output);
  
  log(`Alice address: ${account.address}`);
  
  // Faucetスクリプトの呼び出し
  await runCmd(["./ops/scripts/util/faucet.sh", account.address]);
  log("Faucet completed.");
  
  return account;
}