/**
 * cases/exam1.ts
 * 全チェーンのディスク増分と、フェーズ別時間の記録に対応
 */
import { log, saveResult } from "../lib/common.ts";
import { setupAlice } from "../lib/initialize.ts";
import { createDummyFile, createZip } from "../lib/file.ts";
import { getDiskUsage } from "../lib/stats.ts";
import { uploadToGwcCsu } from "../lib/upload.ts";

// 0.1MBから10MBまで
const SCENARIOS = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  size: 1024 * 1024 * (i + 0.1),
  label: `Scenario ${i + 1}`,
}));

// 256KBだとIBCパケット制限に引っかかるので、少し小さめに
const FRAG_SIZE = 254 * 1024;

export async function runExam1() {
  log("🧪 実験1: アップロードサイズ実験 (詳細計測版)");
  await setupAlice();
  const results = [];
  try {

    for (const s of SCENARIOS) {
      log(`▶️ Scenario ${s.id}: ${s.label}`);
      const testDir = `./tmp_exam1_${s.id}`;
      const zipPath = `${testDir}.zip`;

      await Deno.mkdir(testDir, { recursive: true });
      await createDummyFile(`${testDir}/index.html`, s.size);
      await createZip(testDir, zipPath);

      // 全チェーンの実行前ディスク容量取得
      const diskBefore = {
        gwc: await getDiskUsage("gwc"),
        mdsc: await getDiskUsage("mdsc"),
        fdsc: await getDiskUsage("fdsc"),
      };

      // アップロード実行（詳細なメトリクスが返る）
      const { sid, metrics } = await uploadToGwcCsu(testDir, zipPath, FRAG_SIZE, `exam1-s${s.id}`, "1.0.0");

      // 全チェーンの実行後ディスク容量取得
      const diskAfter = {
        gwc: await getDiskUsage("gwc"),
        mdsc: await getDiskUsage("mdsc"),
        fdsc: await getDiskUsage("fdsc"),
      };

      results.push({
        scenario: s.id,
        label: s.label,
        inputSize: s.size,
        metrics: metrics, // prepTime, uploadTime, verifyTime
        diskDelta: {
          gwc: diskAfter.gwc - diskBefore.gwc,
          mdsc: diskAfter.mdsc - diskBefore.mdsc,
          fdsc: diskAfter.fdsc - diskBefore.fdsc,
          total: (diskAfter.gwc + diskAfter.mdsc + diskAfter.fdsc) - (diskBefore.gwc + diskBefore.mdsc + diskBefore.fdsc)
        },
        overheadRatio: ((diskAfter.fdsc - diskBefore.fdsc) / s.size).toFixed(3),
        sid: sid
      });

      await Deno.remove(testDir, { recursive: true });
      await Deno.remove(zipPath);
    }
  } finally {
    await saveResult("exam1_results", results);
  }
}