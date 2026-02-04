/**
 * cases/exam3.ts
 * ホスティング性能実験: ファイル数による性能・詳細ディスク負荷の変化
 */
import { log, saveResult } from "../lib/common.ts";
import { setupAlice } from "../lib/initialize.ts";
import { createDummyFile, createZip } from "../lib/file.ts";
import { measureTime, getDiskUsage } from "../lib/stats.ts";
import { uploadToGwcCsu } from "../lib/upload.ts";
import { CONFIG } from "../lib/config.ts";

const PATTERNS = [
  { id: "A", count: 1, size: 10 * 1024 * 1024, label: "巨大1枚" },
  { id: "B", count: 10, size: 1 * 1024 * 1024, label: "中規模10枚" },
  { id: "C", count: 100, size: 100 * 1024, label: "小規模100枚" },
  { id: "D", count: 1000, size: 10 * 1024, label: "極小1000枚" },
];

const FRAG_SIZE = 256 * 1024; // 実験3ではフラグメントサイズを固定

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
 * 実行前後のディスク使用量から、Podごとの詳細な差分を計算
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

export async function runExam3() {
  log("🧪 実験3: ホスティング実験 (詳細計測版)");
  await setupAlice();
  const results = [];

  for (const p of PATTERNS) {
    log(`▶️ Pattern ${p.id}: ${p.label}`);
    const testDir = `./tmp_exam3_${p.id}`;
    const zipPath = `${testDir}.zip`;
    await Deno.mkdir(testDir, { recursive: true });

    const files: string[] = [];
    for (let i = 0; i < p.count; i++) {
      const name = `file_${i}.dat`;
      await createDummyFile(`${testDir}/${name}`, p.size);
      files.push(name);
    }
    await createZip(testDir, zipPath);

    const proj = `exam3-p-${p.id.toLowerCase()}`;
    const ver = "1.0.0";

    // --- 実行前のディスク容量取得 (全チェーン) ---
    const diskBefore = {
      gwc: await getDiskUsage("gwc"),
      mdsc: await getDiskUsage("mdsc"),
      fdsc: await getDiskUsage("fdsc"),
    };

    // アップロード実行
    const { sid, metrics } = await uploadToGwcCsu(testDir, zipPath, FRAG_SIZE, proj, ver);

    // --- 実行後のディスク容量取得 (全チェーン) ---
    const diskAfter = {
      gwc: await getDiskUsage("gwc"),
      mdsc: await getDiskUsage("mdsc"),
      fdsc: await getDiskUsage("fdsc"),
    };

    // 全ファイルを並列取得（配信性能）を別途計測
    const { durationMs: bulkFetchTime } = await measureTime(async () => {
      const fetches = files.map(async (n) => {
        const r = await fetch(`${CONFIG.GWC_API}/render/${proj}/${ver}/${n}`);
        if (!r.ok) throw new Error(`Fetch fail: ${n}`);
        await r.arrayBuffer(); 
      });
      await Promise.all(fetches);
    });

    const totalDelta = {
      gwc: sumUsage(diskAfter.gwc) - sumUsage(diskBefore.gwc),
      mdsc: sumUsage(diskAfter.mdsc) - sumUsage(diskBefore.mdsc),
      fdsc: sumUsage(diskAfter.fdsc) - sumUsage(diskBefore.fdsc),
    };

    results.push({
      pattern: p.id,
      label: p.label,
      fileCount: p.count,
      fileSize: p.size,
      uploadMetrics: metrics,
      bulkFetchTimeMs: Math.round(bulkFetchTime),
      // ディスク増分データの追加
      diskDeltaTotal: {
        ...totalDelta,
        sum: totalDelta.gwc + totalDelta.mdsc + totalDelta.fdsc
      },
      diskBreakdownDelta: {
        gwc: calcDiskDelta(diskBefore.gwc, diskAfter.gwc),
        mdsc: calcDiskDelta(diskBefore.mdsc, diskAfter.mdsc),
        fdsc: calcDiskDelta(diskBefore.fdsc, diskAfter.fdsc),
      },
      sid: sid
    });

    await Deno.remove(testDir, { recursive: true });
    await Deno.remove(zipPath);
  }
  await saveResult("exam3_results", results);
}