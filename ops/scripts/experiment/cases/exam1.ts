import { log, saveResult } from "../lib/common.ts";
import { setupAlice } from "../lib/initialize.ts";
import { createDummyFile } from "../lib/file.ts";
import { getDiskUsage, measureTime } from "../lib/stats.ts";
import { uploadToGwc } from "../lib/upload.ts";

export async function runExam1() {
  const alice = await setupAlice();
  const scenarios = [
    { name: "1", size: 250 * 1024, label: "バッチサイズ未満" },
    { name: "2", size: 256 * 1024, label: "境界値(1バッチ)" },
    { name: "6", size: 10 * 1024 * 1024, label: "安定スループット" },
    // 他のシナリオも同様に追加
  ];

  const results = [];

  for (const s of scenarios) {
    log(`Starting Exam1-${s.name}: ${s.label}`);
    const filePath = `./tmp_exam1_${s.name}.bin`;
    await createDummyFile(filePath, s.size);

    const diskBefore = await getDiskUsage("fdsc");
    
    // 前処理とアップロードを分けて計測
    const { result, durationMs: uploadTime } = await measureTime(() => uploadToGwc(filePath, "256KB"));
    
    const diskAfter = await getDiskUsage("fdsc");

    results.push({
      scenario: s.name,
      size: s.size,
      uploadTimeMs: uploadTime,
      gasUsed: result.gasUsed,
      diskDelta: diskAfter - diskBefore,
      overhead: (diskAfter - diskBefore) / s.size
    });
  }

  await saveResult("exam1_upload_size", results);
}