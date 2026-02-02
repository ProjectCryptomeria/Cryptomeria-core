/**
 * lib/stats.ts
 * 複数Podのディスク使用量をPodごと、かつディレクトリごとに詳細に取得するように修正
 */
import { runCmd } from "./common.ts";
import { CONFIG } from "./config.ts";

/**
 * 指定コンポーネントのPodについて、dataディレクトリ配下のサブディレクトリごとの使用量を取得します。
 * 戻り値は { [Pod名]: { [ディレクトリ名]: バイト数 } } の形式になります。
 * * @param comp コンポーネント名 (gwc, mdsc, fdsc)
 * @returns Pod名とディレクトリ名をキーとしたネストされたオブジェクト
 */
export async function getDiskUsage(comp: string): Promise<Record<string, Record<string, number>>> {
  // 指定コンポーネントのラベルを持つPod名をすべて取得
  const podsLine = await runCmd([
    "kubectl", "get", "pod", "-n", CONFIG.NAMESPACE,
    "-l", `app.kubernetes.io/component=${comp}`,
    "-o", "jsonpath={.items[*].metadata.name}"
  ]);

  const podNames = podsLine.trim().split(/\s+/).filter(name => name.length > 0);
  if (podNames.length === 0) return {};

  const podStats: Record<string, Record<string, number>> = {};
  const binName = comp === "gwc" ? "gwcd" : `${comp}d`;
  const appName = binName.replace(/d$/, "");
  const dataPath = `/home/${appName}/.${appName}/data`;

  for (const pod of podNames) {
    const dirStats: Record<string, number> = {};

    // data直下のディレクトリごとのサイズをバイト単位で取得
    const usageOutput = await runCmd([
      "kubectl", "exec", "-n", CONFIG.NAMESPACE, pod, "--",
      "sh", "-c", `du -sb ${dataPath}/*/ 2>/dev/null || true`
    ]);

    const lines = usageOutput.trim().split("\n");
    for (const line of lines) {
      // 出力例: "4096 /home/gwc/.gwc/data/state.db/"
      const match = line.match(/^(\d+)\s+.*\/([^/]+)\/?$/);
      if (match) {
        const bytes = parseInt(match[1], 10);
        const dirName = match[2];
        dirStats[dirName] = bytes;
      }
    }

    podStats[pod] = dirStats;
  }

  return podStats;
}

/**
 * 非同期関数の実行時間を計測する汎用ユーティリティ
 */
export async function measureTime<T>(fn: () => Promise<T>) {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}