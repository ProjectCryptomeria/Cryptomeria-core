/**
 * lib/initialize.ts
 * 実験用ローカルアカウント「alice」のセットアップおよび Faucet 処理
 */
import { runCmd, log } from "./common.ts";
import { CONFIG } from "./config.ts";

/**
 * クラスタ内のミリオネアアカウントから指定のアドレスへ送金する
 */
export async function faucet(address: string, amount: string, targetChain = "gwc") {
  const namespace = CONFIG.NAMESPACE;
  const millionaireKey = "local-admin";
  const denom = CONFIG.DENOM; // configから取得するように調整

  log(`💸 Sending ${amount} to ${address} on [${targetChain}]...`);

  // 1. ターゲットとなる Pod 名を取得
  const podName = await runCmd([
    "kubectl", "get", "pod", "-n", namespace,
    "-l", `app.kubernetes.io/name=${namespace},app.kubernetes.io/component=${targetChain}`,
    "-o", "jsonpath={.items[0].metadata.name}"
  ]);

  if (!podName) {
    throw new Error(`Could not find pod for component: ${targetChain}`);
  }

  // 2. バイナリ名とホームディレクトリの決定
  const binName = targetChain === "gwc" ? "gwcd" : `${targetChain}d`;
  const appName = binName.replace(/d$/, "");
  const homeDir = `/home/${appName}/.${appName}`;

  // 3. 金額のフォーマット (数値のみの場合はデノムを付加)
  const formattedAmount = /^[0-9]+$/.test(amount) ? `${amount}${denom}` : amount;

  // 4. 送金コマンドの実行 (kubectl exec)
  // 修正箇所: "tx", "bank", "send" を個別の引数に分割
  await runCmd([
    "kubectl", "exec", "-n", namespace, podName, "--",
    binName, "tx", "bank", "send", millionaireKey, address, formattedAmount,
    "--chain-id", targetChain,
    "--keyring-backend", "test",
    "--home", homeDir,
    "-y"
  ]);

  log(`✅ Faucet completed: ${formattedAmount} sent to ${address}`);
}

/**
 * 実験用ローカルアカウント「alice」の準備
 */
export async function setupAlice(amount = "10000000uatom") {
  const accountName = "alice";
  const binary = CONFIG.BIN.GWC;

  log(`🛠️  Initializing account '${accountName}' in non-interactive mode...`);

  // キーのクリーンアップ
  try {
    await runCmd([
      binary, "keys", "delete", accountName,
      "--keyring-backend", "test",
      "--yes"
    ]);
  } catch { /* ignore */ }

  // キーの追加
  await runCmd([
    binary, "keys", "add", accountName,
    "--keyring-backend", "test",
    "--output", "json"
  ]);

  // アドレスの取得
  const aliceAddr = await runCmd([
    binary, "keys", "show", accountName,
    "-a",
    "--keyring-backend", "test"
  ]);
  log(`  - Alice Address: ${aliceAddr}`);

  // 資金送金
  await faucet(aliceAddr, amount, "gwc");

  return {
    name: accountName,
    address: aliceAddr
  };
}