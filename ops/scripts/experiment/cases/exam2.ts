/**
 * cases/exam2.ts
 * バッチサイズ（フラグメントサイズ）実験: 連続的なサイズ変更と詳細ディスク計測
 */
import { log, saveResult } from "../lib/common.ts";
import { setupAlice } from "../lib/initialize.ts";
import { createDummyFile, createZip } from "../lib/file.ts";
import { getDiskUsage } from "../lib/stats.ts";
import { uploadToGwcCsu } from "../lib/upload.ts";

// 1KBから256(250)KBまで2倍刻みで設定（比例関係の分析用）
// IBC-goの最大バッチサイズは256KBだが、オーバーヘッドを考慮して250KBに設定
const SCENARIOS = [
  { id: 1, frag: 1 * 1024, label: "1KB" },
  { id: 2, frag: 2 * 1024, label: "2KB" },
  { id: 3, frag: 4 * 1024, label: "4KB" },
  { id: 4, frag: 8 * 1024, label: "8KB" },
  { id: 5, frag: 16 * 1024, label: "16KB" },
  { id: 6, frag: 32 * 1024, label: "32KB" },
  { id: 7, frag: 64 * 1024, label: "64KB" },
  { id: 8, frag: 128 * 1024, label: "128KB" },
  { id: 9, frag: 250 * 1024, label: "250KB" },
];

const FIXED_SIZE = 512 * 1024; // 解析しやすいよう、入力サイズは512KBに固定

/**
 * Podごとのディレクトリサイズ（ネストKV）を合計バイト数に変換
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
 * 実行前後のディスク使用量（ネストKV）から、Podごとの詳細な差分を計算
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

export async function runExam2() {
  log("🧪 実験2: バッチサイズ実験 (2^n シーケンス & 詳細計測版)");
  await setupAlice();
  const results = [];
try{
  for (const s of SCENARIOS) {
    log(`▶️ Scenario ${s.id}: Frag ${s.label} (${s.frag} Bytes)`);
    const testDir = `./tmp_exam2_${s.id}`;
    const zipPath = `${testDir}.zip`;

    await Deno.mkdir(testDir, { recursive: true });
    await createDummyFile(`${testDir}/index.html`, FIXED_SIZE);
    await createZip(testDir, zipPath);

    // --- 実行前のディスク容量取得 (全チェーン) ---
    const diskBefore = {
      gwc: await getDiskUsage("gwc"),
      mdsc: await getDiskUsage("mdsc"),
      fdsc: await getDiskUsage("fdsc"),
    };

    // --- アップロード実行 ---
    const { sid, metrics } = await uploadToGwcCsu(testDir, zipPath, s.frag, `exam2-s${s.id}`, "1.0.0");

    // --- 実行後のディスク容量取得 (全チェーン) ---
    const diskAfter = {
      gwc: await getDiskUsage("gwc"),
      mdsc: await getDiskUsage("mdsc"),
      fdsc: await getDiskUsage("fdsc"),
    };

    // 合計値の計算
    const totalDelta = {
      gwc: sumUsage(diskAfter.gwc) - sumUsage(diskBefore.gwc),
      mdsc: sumUsage(diskAfter.mdsc) - sumUsage(diskBefore.mdsc),
      fdsc: sumUsage(diskAfter.fdsc) - sumUsage(diskBefore.fdsc),
    };

    results.push({
      scenario: s.id,
      label: s.label,
      fragSize: s.frag,
      inputSize: FIXED_SIZE,
      metrics: metrics,
      // 合計増加量
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
      sid: sid
    });

    await Deno.remove(testDir, { recursive: true });
    await Deno.remove(zipPath);
  }
}catch(e){
  log(`❌ Error: ${e}`);
}finally{
  await saveResult("exam2_results", results);
}
}