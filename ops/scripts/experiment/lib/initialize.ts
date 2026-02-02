/**
 * lib/initialize.ts
 */
import { runCmd, log } from "./common.ts";
import { CONFIG } from "./config.ts";

/**
 * 指定したアドレスの残高（CONFIG.DENOM）を取得する
 */
export async function getBalance(address: string): Promise<number> {
  try {
    const output = await runCmd([
      CONFIG.BIN.GWC, "q", "bank", "balances", address,
      "--node", CONFIG.GWC_RPC,
      "--output", "json"
    ]);
    const res = JSON.parse(output);
    const coin = res.balances?.find((c: any) => c.denom === CONFIG.DENOM);
    return coin ? parseInt(coin.amount) : 0;
  } catch {
    return 0; // アカウントが存在しない場合など
  }
}

/**
 * アカウントがオンチェーンに存在するか確認する
 */
async function isAccountCreated(address: string): Promise<boolean> {
  try {
    await runCmd([
      CONFIG.BIN.GWC, "q", "auth", "account", address,
      "--node", CONFIG.GWC_RPC,
      "--output", "json"
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Faucet処理
 */
export async function faucet(address: string, amount: string, targetComponent = "gwc") {
  const namespace = CONFIG.NAMESPACE;
  const millionaireKey = "local-admin";
  const denom = CONFIG.DENOM;
  const chainId = CONFIG.CHAIN_ID;

  log(`💸 Sending ${amount} to ${address} on [${targetComponent}] (Chain: ${chainId})...`);

  const podName = await runCmd([
    "kubectl", "get", "pod", "-n", namespace,
    "-l", `app.kubernetes.io/name=${namespace},app.kubernetes.io/component=${targetComponent}`,
    "-o", "jsonpath={.items[0].metadata.name}"
  ]);

  const binName = targetComponent === "gwc" ? "gwcd" : `${targetComponent}d`;
  const appName = binName.replace(/d$/, "");
  const homeDir = `/home/${appName}/.${appName}`;
  const formattedAmount = /^[0-9]+$/.test(amount) ? `${amount}${denom}` : amount;

  await runCmd([
    "kubectl", "exec", "-n", namespace, podName, "--",
    binName, "tx", "bank", "send", millionaireKey, address, formattedAmount,
    "--chain-id", chainId,
    "--keyring-backend", "test",
    "--home", homeDir,
    "-y"
  ]);

  log(`⏳ Waiting for account confirmation on-chain...`);
  for (let i = 0; i < 30; i++) {
    if (await isAccountCreated(address)) {
      log(`✅ Account confirmed.`);
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("Faucet confirmation timeout.");
}

/**
 * 実験用ローカルアカウント「alice」の準備
 * 残高が targetAmountNum 未満の場合のみ Faucet を実行する
 */
export async function setupAlice(targetAmountNum = 10000000) {
  const accountName = "alice";
  const binary = CONFIG.BIN.GWC;

  log(`🛠️  Setting up account '${accountName}'...`);

  // 1. ローカルキーの存在確認（なければ作成）
  let address = "";
  try {
    address = await runCmd([binary, "keys", "show", accountName, "-a", "--keyring-backend", "test"]);
    log(`  - Local key found: ${address}`);
  } catch {
    log(`  - Local key not found. Creating new key...`);
    const addRes = await runCmd([binary, "keys", "add", accountName, "--keyring-backend", "test", "--output", "json"]);
    address = JSON.parse(addRes).address;
  }

  // 2. オンチェーンの残高確認
  const currentBalance = await getBalance(address);
  if (currentBalance < targetAmountNum) {
    log(`  - Balance insufficient (${currentBalance} < ${targetAmountNum}). Starting faucet...`);
    await faucet(address, targetAmountNum.toString(), "gwc");
  } else {
    log(`  - Balance sufficient (${currentBalance}${CONFIG.DENOM}). Skipping faucet.`);
  }

  return { name: accountName, address };
}