/**
 * cases/exam1.ts (共通化・ランダム化適用版)
 */
import { log, saveResult } from "../lib/common.ts";
import { setupAlice } from "../lib/initialize.ts";
import { createDummyFile, createZip } from "../lib/file.ts";
import { uploadToGwcCsu } from "../lib/upload.ts";
import { runStandardScenario, generateRandomId } from "../lib/runner.ts";

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

export async function runExam1() {
  log("🧪 実験1: アップロードサイズ実験 (リファクタリング版)");
  await setupAlice();
  const results = [];
  const examRand = generateRandomId(4); // 実験全体で共有するランダムID

  try {
    for (const s of SCENARIOS) {
      log(`▶️ Scenario ${s.id}: ${s.label} (${(s.size / 1024 / 1024).toFixed(2)} MB)`);
      const testDir = `./tmp_exam1_s${s.id}_n${FDSC_NUM}_${examRand}`;
      const zipPath = `${testDir}.zip`;

      await Deno.mkdir(testDir, { recursive: true });
      await createDummyFile(`${testDir}/index.html`, s.size);
      await createZip(testDir, zipPath);
      const projectName = `exam1-s${s.id}-n${FDSC_NUM}`;
      // 共通ワークフローの呼び出し
      const scenarioResult = await runStandardScenario(
        s.id,
        projectName, // これに runner 内でランダム文字列が付与される
        () => uploadToGwcCsu(testDir, zipPath, FRAG_SIZE, projectName, "1.0.0", FDSC_NUM)
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