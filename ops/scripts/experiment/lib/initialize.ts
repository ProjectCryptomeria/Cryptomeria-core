/**
 * lib/initialize.ts
 * アカウントのセットアップと、オンチェーンでの存在確認待機
 */
import { runCmd, log } from "./common.ts";
import { CONFIG } from "./config.ts";

/**
 * アカウントがオンチェーンに存在するか（残高があるか）を確認する
 */
async function isAccountCreated(address: string): Promise<boolean> {
  try {
    // 修正: ポートフォワードされたRPCノードを明示的に指定
    const output = await runCmd([
      CONFIG.BIN.GWC, "q", "auth", "account", address,
      "--node", CONFIG.GWC_RPC,
      "--output", "json"
    ]);
    return !!output;
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
  const chainId = CONFIG.CHAIN_ID; // 修正: configのChain IDを使用

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
    "--chain-id", chainId, // 修正: gwc ではなく gwc-1 などの正しいIDを渡す
    "--keyring-backend", "test",
    "--home", homeDir,
    "-y"
  ]);

  log(`  - Faucet transaction broadcasted.`);

  // 重要: アカウントがオンチェーンで認識されるまで待機 (最大10秒)
  log(`⏳ Waiting for account ${address} to be created on-chain...`);
  for (let i = 0; i < 10; i++) {
    if (await isAccountCreated(address)) {
      log(`✅ Account confirmed on-chain.`);
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("Timeout: Account was not created on-chain after faucet.");
}

/**
 * 実験用ローカルアカウント「alice」の準備
 */
export async function setupAlice(amount = "10000000uatom") {
  const accountName = "alice";
  const binary = CONFIG.BIN.GWC;

  log(`🛠️  Initializing account '${accountName}'...`);

  try {
    await runCmd([binary, "keys", "delete", accountName, "--keyring-backend", "test", "--yes"]);
  } catch { /* ignore */ }

  await runCmd([binary, "keys", "add", accountName, "--keyring-backend", "test", "--output", "json"]);

  const aliceAddr = await runCmd([binary, "keys", "show", accountName, "-a", "--keyring-backend", "test"]);
  log(`  - Local Alice Address: ${aliceAddr}`);

  // Faucet実行（待機ロジック内蔵）
  await faucet(aliceAddr, amount, "gwc");

  return { name: accountName, address: aliceAddr };
}