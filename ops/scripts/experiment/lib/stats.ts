import { runCmd } from "./common.ts";
import { CONFIG } from "./config.ts";

/**
 * Pod情報取得とディスク・時間計測
 */
export async function getDiskUsage(component: string) {
  // component: gwc, mdsc, fdsc
  // kubectl exec を用いて各Podのデータディレクトリサイズを取得
  const podName = await runCmd([
    "kubectl", "get", "pod", "-n", CONFIG.NAMESPACE,
    "-l", `app.kubernetes.io/name=${CONFIG.NAMESPACE},app.kubernetes.io/component=${component}`,
    "-o", "jsonpath={.items[0].metadata.name}"
  ]);

  const usage = await runCmd([
    "kubectl", "exec", "-n", CONFIG.NAMESPACE, podName, "--", "du", "-sb", "/root/.cryptomeria/data"
  ]);
  return parseInt(usage.split("\t")[0]);
}

export async function measureTime<T>(fn: () => Promise<T>): Promise<{ result: T, durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const end = performance.now();
  return { result, durationMs: end - start };
}