/**
 * cases/exam2.ts (共通化・ランダム化適用版)
 */
import { log, saveResult } from "../lib/common.ts";
import { setupAlice } from "../lib/initialize.ts";
import { createDummyFile, createZip } from "../lib/file.ts";
import { uploadToGwcCsu } from "../lib/upload.ts";
import { runStandardScenario, generateRandomId } from "../lib/runner.ts";

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

const FIXED_SIZE = 512 * 1024; // 512KB固定
const FDSC_NUMS = [1,2,3,4];

async function runExam2Core(fdscNum: number) {
  log("🧪 実験2: バッチサイズ実験 (リファクタリング版)");
  await setupAlice();
  const results = [];
  const examRand = generateRandomId(4);

  try {
    for (const s of SCENARIOS) {
      log(`▶️ Scenario ${s.id}: Frag ${s.label} (${s.frag} Bytes)`);
      const testDir = `./tmp_exam2_s${s.id}_f${s.frag}_n${fdscNum}_${examRand}`;
      const zipPath = `${testDir}.zip`;

      await Deno.mkdir(testDir, { recursive: true });
      await createDummyFile(`${testDir}/index.html`, FIXED_SIZE);
      await createZip(testDir, zipPath);

      const projectName = `exam2-s${s.id}-f${s.frag}-n${fdscNum}`;

      // 共通ワークフローの呼び出し
      const scenarioResult = await runStandardScenario(
        s.id,
        projectName,
        () => uploadToGwcCsu(testDir, zipPath, s.frag, projectName, "1.0.0",  fdscNum)
      );

      results.push({
        scenario: s.id,
        label: s.label,
        fragSize: s.frag,
        inputSize: FIXED_SIZE,
        ...scenarioResult
      });

      await Deno.remove(testDir, { recursive: true });
      await Deno.remove(zipPath);
    }
  } catch (e) {
    log(`❌ Error: ${e}`);
  } finally {
    await saveResult(`exam2_results_${examRand}`, results);
  }
}

export async function runExam2() {
  for (const fdscNum of FDSC_NUMS) {
    await runExam2Core(fdscNum);
  }
}