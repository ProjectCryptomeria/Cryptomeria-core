/**
 * lib/stats.ts
 * Pod情報の取得およびディスク・時間計測
 */
import { runCmd } from "./common.ts";
import { CONFIG } from "./config.ts";

/**
 * Pod内のデータディレクトリのディスク使用量をバイト単位で取得する
 */
export async function getDiskUsage(component: string) {
  const namespace = CONFIG.NAMESPACE;
  
  // 1. ターゲットとなる Pod 名を取得
  const podName = await runCmd([
    "kubectl", "get", "pod", "-n", namespace,
    "-l", `app.kubernetes.io/name=${namespace},app.kubernetes.io/component=${component}`,
    "-o", "jsonpath={.items[0].metadata.name}"
  ]);

  if (!podName) {
    throw new Error(`Could not find pod for component: ${component}`);
  }

  // 2. バイナリ名からホームディレクトリのパスを構成 (initialize.ts のロジックと同期)
  const binName = component === "gwc" ? "gwcd" : `${component}d`;
  const appName = binName.replace(/d$/, "");
  const homeDir = `/home/${appName}/.${appName}`;
  const dataDir = `${homeDir}/data`;

  // 3. du コマンドでサイズを取得
  // Permission Denied を避けるため、パスが正しいことを確認
  try {
    const usage = await runCmd([
      "kubectl", "exec", "-n", namespace, podName, "--", 
      "du", "-sb", dataDir
    ]);
    return parseInt(usage.split("\t")[0]);
  } catch (e) {
    // もし /home/... が失敗した時のためのフォールバック、またはエラー詳細の表示
    console.error(`Failed to access ${dataDir} in ${podName}. Checking path...`);
    throw e;
  }
}

/**
 * 非同期関数の実行時間を計測するラッパー
 */
export async function measureTime<T>(fn: () => Promise<T>): Promise<{ result: T, durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const end = performance.now();
  return { result, durationMs: end - start };
}