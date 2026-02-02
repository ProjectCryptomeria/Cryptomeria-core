/**
 * lib/stats.ts
 * 実験データの収集（ディスク使用量、実行時間など）
 */
import { runCmd } from "./common.ts";
import { CONFIG } from "./config.ts";

/**
 * 指定されたコンポーネントPodのデータディレクトリのディスク使用量をバイト単位で取得する。
 * スキャン中に一時ファイルが削除されることによる失敗を回避するため、
 * 標準エラーを無視し、常に成功コードを返すようにラップして実行する。
 */
export async function getDiskUsage(comp: string): Promise<number> {
  // コンポーネントに対応するPod名を取得
  const pod = await runCmd([
    "kubectl", "get", "pod", "-n", CONFIG.NAMESPACE,
    "-l", `app.kubernetes.io/component=${comp}`,
    "-o", "jsonpath={.items[0].metadata.name}"
  ]);

  const bin = comp === "gwc" ? "gwcd" : `${comp}d`;
  const app = bin.replace(/d$/, "");
  const dataPath = `/home/${app}/.${app}/data`;

  // duコマンドは、Tendermintのアトミック書き込み用の一時ファイル消失などで失敗しやすいため、
  // sh -c を介してエラーを抑制し、可能な範囲の出力を取得する。
  const usage = await runCmd([
    "kubectl", "exec", "-n", CONFIG.NAMESPACE, pod, "--",
    "sh", "-c", `du -sb ${dataPath} 2>/dev/null || true`
  ]);

  // 出力の最初の数値（バイト数）を抽出
  const sizeMatch = usage.trim().match(/^(\d+)/);
  return sizeMatch ? parseInt(sizeMatch[1]) : 0;
}

/**
 * 非同期関数の実行時間をミリ秒単位で計測するラッパー
 */
export async function measureTime<T>(fn: () => Promise<T>) {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}