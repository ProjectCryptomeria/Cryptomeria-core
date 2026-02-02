/**
 * lib/stats.ts
 * 複数Podのディスク使用量を合算するように修正
 */
import { runCmd } from "./common.ts";
import { CONFIG } from "./config.ts";

export async function getDiskUsage(comp: string): Promise<number> {
  // 指定コンポーネントに属するすべてのPod名を取得（スペース区切り）
  const podsLine = await runCmd([
    "kubectl", "get", "pod", "-n", CONFIG.NAMESPACE,
    "-l", `app.kubernetes.io/component=${comp}`,
    "-o", "jsonpath={.items[*].metadata.name}"
  ]);

  const podNames = podsLine.trim().split(/\s+/).filter(n => n.length > 0);
  if (podNames.length === 0) return 0;

  let totalBytes = 0;
  const bin = comp === "gwc" ? "gwcd" : `${comp}d`;
  const app = bin.replace(/d$/, "");
  const dataPath = `/home/${app}/.${app}/data`;

  for (const pod of podNames) {
    const usage = await runCmd([
      "kubectl", "exec", "-n", CONFIG.NAMESPACE, pod, "--",
      "sh", "-c", `du -sb ${dataPath} 2>/dev/null || true`
    ]);

    const sizeMatch = usage.trim().match(/^(\d+)/);
    if (sizeMatch) {
      totalBytes += parseInt(sizeMatch[1]);
    }
  }

  return totalBytes;
}

export async function measureTime<T>(fn: () => Promise<T>) {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}