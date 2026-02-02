/**
 * cases/exam1.ts
 */
import { log, saveResult } from "../lib/common.ts";
import { setupAlice } from "../lib/initialize.ts";
import { createDummyFile, createZip } from "../lib/file.ts";
import { getDiskUsage, measureTime } from "../lib/stats.ts";
import { uploadToGwcCsu } from "../lib/upload.ts";

const SCENARIOS = [
  { id: 1, size: 250 * 1024, label: "バッチサイズ未満" },
  { id: 2, size: 256 * 1024, label: "ちょうど1バッチ" },
  { id: 3, size: 260 * 1024, label: "1バイト超過" },
  { id: 4, size: 512 * 1024, label: "ちょうど2バッチ" },
  { id: 5, size: 1.25 * 1024 * 1024, label: "数回の分割" },
  { id: 6, size: 10 * 1024 * 1024, label: "安定スループット" },
  { id: 7, size: 100 * 1024 * 1024, label: "大容量・維持確認" },
];

const FRAG_SIZE = 256 * 1024;

export async function runExam1() {
  log("🧪 実験1: アップロードサイズ実験");
  await setupAlice();
  const results = [];

  for (const s of SCENARIOS) {
    log(`▶️ Scenario ${s.id}: ${s.label}`);
    const testDir = `./tmp_exam1_${s.id}`;
    const zipPath = `${testDir}.zip`;

    await Deno.mkdir(testDir, { recursive: true });
    await createDummyFile(`${testDir}/index.html`, s.size);
    await createZip(testDir, zipPath);

    const diskBefore = await getDiskUsage("fdsc");
    const { result, durationMs } = await measureTime(() =>
      uploadToGwcCsu(testDir, zipPath, FRAG_SIZE, `exam1-s${s.id}`, "1.0.0")
    );
    const diskAfter = await getDiskUsage("fdsc");

    results.push({
      scenario: s.id,
      size: s.size,
      timeMs: Math.round(durationMs),
      diskDelta: diskAfter - diskBefore,
      sid: result?.sid
    });

    await Deno.remove(testDir, { recursive: true });
    await Deno.remove(zipPath);
  }
  await saveResult("exam1_results", results);
}