/**
 * cases/exam1.ts
 * Pod単位・ディレクトリ単位のディスク増分記録に対応
 */
import { log, saveResult } from "../lib/common.ts";
import { setupAlice } from "../lib/initialize.ts";
import { createDummyFile, createZip } from "../lib/file.ts";
import { getDiskUsage } from "../lib/stats.ts";
import { uploadToGwcCsu } from "../lib/upload.ts";

const SCENARIOS = [
  {id:1,size:1024*1024*0.1,label:"0.1MB"},
  {id:2,size:1024*1024*0.2,label:"0.2MB"},
  {id:3,size:1024*1024*0.3,label:"0.3MB"},
  {id:4,size:1024*1024*0.4,label:"0.4MB"},
  {id:5,size:1024*1024*0.5,label:"0.5MB"},
  {id:6,size:1024*1024*0.6,label:"0.6MB"},
  {id:7,size:1024*1024*0.7,label:"0.7MB"},
  {id:8,size:1024*1024*0.8,label:"0.8MB"},
  {id:9,size:1024*1024*0.9,label:"0.9MB"},
  {id:10,size:1024*1024*1.0,label:"1.0MB"},
];

const FRAG_SIZE = 254 * 1024;
const FDSC_NUM = 2;

/**
 * Podごとのディレクトリサイズ（ネストKV）を合計バイト数に変換する
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
 * 実行前後のディスク使用量（ネストKV）から、Podごとの差分を計算する
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

export async function runExam1() {
  log("🧪 実験1: アップロードサイズ実験 (Pod別詳細計測版)");
  await setupAlice();
  const results = [];

  try {
    for (const s of SCENARIOS) {
      log(`▶️ Scenario ${s.id}: ${s.label} (${(s.size / 1024 / 1024).toFixed(2)} MB)`);
      const testDir = `./tmp_exam1_${s.id}`;
      const zipPath = `${testDir}.zip`;

      await Deno.mkdir(testDir, { recursive: true });
      await createDummyFile(`${testDir}/index.html`, s.size);
      await createZip(testDir, zipPath);

      // --- 実行前のディスク容量取得 (Pod別) ---
      const diskBefore = {
        gwc: await getDiskUsage("gwc"),
        mdsc: await getDiskUsage("mdsc"),
        fdsc: await getDiskUsage("fdsc"),
      };

      // --- アップロード実行 ---
      const { sid, metrics } = await uploadToGwcCsu(testDir, zipPath, FRAG_SIZE, `exam1-s${s.id}`, "1.0.0", FDSC_NUM);

      // --- 実行後のディスク容量取得 (Pod別) ---
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

      results.push({
        scenario: s.id,
        label: s.label,
        inputSize: s.size,
        metrics: metrics,
        diskDeltaTotal: {
          ...totalDelta,
          sum: totalDelta.gwc + totalDelta.mdsc + totalDelta.fdsc
        },
        // Podごと・データベースディレクトリごとの詳細な増加量
        diskBreakdownDelta: {
          gwc: calcDiskDelta(diskBefore.gwc, diskAfter.gwc),
          mdsc: calcDiskDelta(diskBefore.mdsc, diskAfter.mdsc),
          fdsc: calcDiskDelta(diskBefore.fdsc, diskAfter.fdsc),
        },
        overheadRatio: (totalDelta.fdsc / s.size).toFixed(3),
        sid: sid
      });

      await Deno.remove(testDir, { recursive: true });
      await Deno.remove(zipPath);
    }
  } finally {
    await saveResult("exam1_results", results);
  }
}