/**
 * lib/initialize.ts
 */
import { runCmd, log } from "./common.ts";
import { CONFIG } from "./config.ts";

async function isAccountCreated(address: string): Promise<boolean> {
  try {
    await runCmd([CONFIG.BIN.GWC, "q", "auth", "account", address, "--node", CONFIG.GWC_RPC, "--output", "json"]);
    return true;
  } catch { return false; }
}

export async function setupAlice(targetAmount = 10000000) {
  const binary = CONFIG.BIN.GWC;
  let aliceAddr = "";
  try {
    aliceAddr = await runCmd([binary, "keys", "show", "alice", "-a", "--keyring-backend", "test"]);
  } catch {
    const out = await runCmd([binary, "keys", "add", "alice", "--keyring-backend", "test", "--output", "json"]);
    aliceAddr = JSON.parse(out).address;
  }

  // 残高確認
  try {
    const balOut = await runCmd([binary, "q", "bank", "balances", aliceAddr, "--node", CONFIG.GWC_RPC, "-o", "json"]);
    const bal = JSON.parse(balOut).balances?.find((b: any) => b.denom === CONFIG.DENOM);
    if (bal && parseInt(bal.amount) >= targetAmount) {
      log("✅ Alice balance sufficient.");
      return { address: aliceAddr };
    }
  } catch { /* ignore */ }

  log("💸 Requesting Faucet...");
  const pod = await runCmd(["kubectl", "get", "pod", "-n", CONFIG.NAMESPACE, "-l", "app.kubernetes.io/component=gwc", "-o", "jsonpath={.items[0].metadata.name}"]);
  await runCmd(["kubectl", "exec", "-n", CONFIG.NAMESPACE, pod, "--", "gwcd", "tx", "bank", "send", "local-admin", aliceAddr, `${targetAmount}${CONFIG.DENOM}`, "--chain-id", CONFIG.CHAIN_ID, "--keyring-backend", "test", "--home", "/home/gwc/.gwc", "-y"]);

  for (let i = 0; i < 20; i++) {
    if (await isAccountCreated(aliceAddr)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  return { address: aliceAddr };
}