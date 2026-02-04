/**
 * lib/runner.ts
 */
import { log, saveResult } from "./common.ts";
import { setupAlice } from "./initialize.ts";
import { getDiskUsage } from "./stats.ts";
import { uploadToGwcCsu, UploadMetrics } from "./upload.ts";

export interface DiskDelta {
  gwc: number;
  mdsc: number;
  fdsc: number;
  sum: number;
}

/**
 * ランダムなIDを生成（プロジェクト名やファイル名に使用）
 */
export function generateRandomId(length = 6): string {
  return Math.random().toString(36).substring(2, 2 + length);
}

/**
 * Podごとのディレクトリサイズを合計バイト数に変換
 */
function sumUsage(podUsage: Record<string, Record<string, number>>): number {
  let total = 0;
  for (const pod in podUsage) {
    for (const dir in podUsage[pod]) {
      total += podUsage[pod][dir];
    }
  }
  return total;
}

/**
 * 実行前後のディスク使用量からPodごとの詳細な差分を計算
 */
function calcDiskDelta(
  before: Record<string, Record<string, number>>,
  after: Record<string, Record<string, number>>
): Record<string, Record<string, number>> {
  const delta: Record<string, Record<string, number>> = {};
  for (const podName in after) {
    delta[podName] = {};
    const beforePod = before[podName] || {};
    for (const dirName in after[podName]) {
      delta[podName][dirName] = after[podName][dirName] - (beforePod[dirName] || 0);
    }
  }
  return delta;
}

/**
 * 実験の標準ワークフロー（計測 -> 実行 -> 計測 -> 集計）をカプセル化
 */
export async function runStandardScenario(
  scenarioId: string | number,
  projectNameBase: string,
  executeUpload: () => Promise<{ sid: string; metrics: UploadMetrics }>
) {
  const rand = generateRandomId();
  const fullProjectName = `${projectNameBase}-${rand}`;

  // --- 実行前のディスク容量取得 ---
  const diskBefore = {
    gwc: await getDiskUsage("gwc"),
    mdsc: await getDiskUsage("mdsc"),
    fdsc: await getDiskUsage("fdsc"),
  };

  // --- アップロード実行 ---
  const { sid, metrics } = await executeUpload();

  // --- 実行後のディスク容量取得 ---
  const diskAfter = {
    gwc: await getDiskUsage("gwc"),
    mdsc: await getDiskUsage("mdsc"),
    fdsc: await getDiskUsage("fdsc"),
  };

  const totalDelta = {
    gwc: sumUsage(diskAfter.gwc) - sumUsage(diskBefore.gwc),
    mdsc: sumUsage(diskAfter.mdsc) - sumUsage(diskBefore.mdsc),
    fdsc: sumUsage(diskAfter.fdsc) - sumUsage(diskBefore.fdsc),
  };

  return {
    sid,
    metrics,
    projectName: fullProjectName,
    diskDeltaTotal: {
      ...totalDelta,
      sum: totalDelta.gwc + totalDelta.mdsc + totalDelta.fdsc
    },
    diskBreakdownDelta: {
      gwc: calcDiskDelta(diskBefore.gwc, diskAfter.gwc),
      mdsc: calcDiskDelta(diskBefore.mdsc, diskAfter.mdsc),
      fdsc: calcDiskDelta(diskBefore.fdsc, diskAfter.fdsc),
    },
  };
}