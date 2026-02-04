/**
 * cases/exam1.ts (共通化・ランダム化適用版)
 */
import { log, saveResult } from "../lib/common.ts";
import { setupAlice } from "../lib/initialize.ts";
import { createDummyFile, createZip } from "../lib/file.ts";
import { uploadToGwcCsu } from "../lib/upload.ts";
import { runStandardScenario, generateRandomId } from "../lib/runner.ts";

const SCENARIOS = [
  // {id:1,size:1024*1024*1,label:"1MB"},
  // {id:2,size:1024*1024*10,label:"10MB"},
  {id:3,size:1024*1024*50,label:"50MB"},
  {id:4,size:1024*1024*100,label:"100MB"},
];

const FRAG_SIZE = 254 * 1024;
const FDSC_NUMS = [4];

async function runExam1Core(fdscNum: number) {
  log("🧪 実験1: アップロードサイズ実験 (リファクタリング版)");
  await setupAlice();
  const results = [];
  const examRand = generateRandomId(4); // 実験全体で共有するランダムID

  try {
    for (const s of SCENARIOS) {
      log(`▶️ Scenario ${s.id}: ${s.label} (${(s.size / 1024 / 1024).toFixed(2)} MB)`);
      const testDir = `./tmp_exam1_s${s.id}_n${fdscNum}_${examRand}`;
      const zipPath = `${testDir}.zip`;

      await Deno.mkdir(testDir, { recursive: true });
      await createDummyFile(`${testDir}/index.html`, s.size);
      await createZip(testDir, zipPath);
      const projectName = `exam1-s${s.id}-n${fdscNum}`;
      // 共通ワークフローの呼び出し
      const scenarioResult = await runStandardScenario(
        s.id,
        projectName, // これに runner 内でランダム文字列が付与される
        () => uploadToGwcCsu(testDir, zipPath, FRAG_SIZE, projectName, "1.0.0", fdscNum)
      );

      results.push({
        scenario: s.id,
        label: s.label,
        inputSize: s.size,
        overheadRatio: (scenarioResult.diskDeltaTotal.fdsc / s.size).toFixed(3),
        ...scenarioResult
      });

      await Deno.remove(testDir, { recursive: true });
      await Deno.remove(zipPath);
    }
  } finally {
    // 結果ファイル名にランダムIDを含めて保存
    await saveResult(`exam1_results_${examRand}`, results);
  }
}

export async function runExam1() {
  for (const fdscNum of FDSC_NUMS) {
    await runExam1Core(fdscNum);
  }
}
