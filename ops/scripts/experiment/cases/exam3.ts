/**
 * cases/exam3.ts (共通化・ランダム化適用版)
 */
import { log, saveResult } from "../lib/common.ts";
import { setupAlice } from "../lib/initialize.ts";
import { createDummyFile, createZip } from "../lib/file.ts";
import { measureTime } from "../lib/stats.ts";
import { uploadToGwcCsu } from "../lib/upload.ts";
import { runStandardScenario, generateRandomId } from "../lib/runner.ts";
import { CONFIG } from "../lib/config.ts";

const PATTERNS = [
  { id: "A", count: 1, size: 10 * 1024 * 1024, label: "巨大1枚" },
  { id: "B", count: 10, size: 1 * 1024 * 1024, label: "中規模10枚" },
  { id: "C", count: 100, size: 100 * 1024, label: "小規模100枚" },
  { id: "D", count: 1000, size: 10 * 1024, label: "極小1000枚" },
];

const FRAG_SIZE = 256 * 1024;
const FDSC_NUM = 2;

export async function runExam3() {
  log("🧪 実験3: ホスティング実験 (リファクタリング版)");
  await setupAlice();
  const results = [];
  const examRand = generateRandomId(4);

  for (const p of PATTERNS) {
    log(`▶️ Pattern ${p.id}: ${p.label}`);
    const testDir = `./tmp_exam3_p${p.id}_c${p.count}_n${FDSC_NUM}_${examRand}`;
    const zipPath = `${testDir}.zip`;
    await Deno.mkdir(testDir, { recursive: true });

    const files: string[] = [];
    for (let i = 0; i < p.count; i++) {
      const name = `file_${i}.dat`;
      await createDummyFile(`${testDir}/${name}`, p.size);
      files.push(name);
    }
    await createZip(testDir, zipPath);

    const projectName = `exam3-p${p.id.toLowerCase()}-c${p.count}-n${FDSC_NUM}`;
    const version = "1.0.0";

    // 共通ワークフローの呼び出し
    const scenarioResult = await runStandardScenario(
      p.id,
      projectName,
      () => uploadToGwcCsu(testDir, zipPath, FRAG_SIZE, projectName, version, FDSC_NUM)
    );

    // 実験3固有：全ファイルを並列取得する配信性能の計測
    log(`  - 配信性能の計測開始 (${p.count} files)...`);
    const { durationMs: bulkFetchTime } = await measureTime(async () => {
      const fetches = files.map(async (n) => {
        // runnerによってランダム化された最終的なプロジェクト名を使用
        const url = `${CONFIG.GWC_API}/render/${scenarioResult.projectName}/${version}/${n}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`Fetch fail: ${n} at ${url}`);
        await r.arrayBuffer(); 
      });
      await Promise.all(fetches);
    });

    results.push({
      pattern: p.id,
      label: p.label,
      fileCount: p.count,
      fileSize: p.size,
      bulkFetchTimeMs: Math.round(bulkFetchTime),
      ...scenarioResult
    });

    await Deno.remove(testDir, { recursive: true });
    await Deno.remove(zipPath);
  }
  await saveResult(`exam3_results_${examRand}`, results);
}