/**
 * cases/exam2.ts
 */
import { log, saveResult } from "../lib/common.ts";
import { setupAlice } from "../lib/initialize.ts";
import { createDummyFile, createZip } from "../lib/file.ts";
import { getDiskUsage, measureTime } from "../lib/stats.ts";
import { uploadToGwcCsu } from "../lib/upload.ts";

const SCENARIOS = [
  { id: 1, frag: 256 * 1024, label: "MAXサイズ" },
  { id: 2, frag: 171 * 1024, label: "中途半端" },
  { id: 3, frag: 128 * 1024, label: "半分" },
  { id: 4, frag: 64 * 1024, label: "倍増" },
  { id: 5, frag: 32 * 1024, label: "低下傾向" },
  { id: 6, frag: 8 * 1024, label: "パケットサイズ" },
  { id: 7, frag: 1 * 1024, label: "限界値" },
];

const FIXED_SIZE = 512 * 1024;

export async function runExam2() {
  log("🧪 実験2: バッチサイズ実験");
  await setupAlice();
  const results = [];

  for (const s of SCENARIOS) {
    log(`▶️ Scenario ${s.id}: ${s.label} (Frag: ${s.frag})`);
    const testDir = `./tmp_exam2_${s.id}`;
    const zipPath = `${testDir}.zip`;

    await Deno.mkdir(testDir, { recursive: true });
    await createDummyFile(`${testDir}/index.html`, FIXED_SIZE);
    await createZip(testDir, zipPath);

    const diskBefore = await getDiskUsage("fdsc");
    const { result, durationMs } = await measureTime(() =>
      uploadToGwcCsu(testDir, zipPath, s.frag, `exam2-s${s.id}`, "1.0.0")
    );
    const diskAfter = await getDiskUsage("fdsc");

    results.push({
      scenario: s.id,
      frag: s.frag,
      timeMs: Math.round(durationMs),
      diskDelta: diskAfter - diskBefore,
      sid: result?.sid
    });

    await Deno.remove(testDir, { recursive: true });
    await Deno.remove(zipPath);
  }
  await saveResult("exam2_results", results);
}