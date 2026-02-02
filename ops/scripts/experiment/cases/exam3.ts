/**
 * cases/exam3.ts
 */
import { log, saveResult } from "../lib/common.ts";
import { setupAlice } from "../lib/initialize.ts";
import { createDummyFile, createZip } from "../lib/file.ts";
import { measureTime } from "../lib/stats.ts";
import { uploadToGwcCsu } from "../lib/upload.ts";
import { CONFIG } from "../lib/config.ts";

interface Exam3Result {
  pattern: string;
  timeMs: number;
}

const PATTERNS = [
  { id: "A", count: 1, size: 10 * 1024 * 1024, label: "巨大1枚" },
  { id: "B", count: 10, size: 1 * 1024 * 1024, label: "中規模10枚" },
  { id: "C", count: 100, size: 100 * 1024, label: "小規模100枚" },
  { id: "D", count: 1000, size: 10 * 1024, label: "極小1000枚" },
];

export async function runExam3() {
  log("🧪 実験3: ホスティング実験");
  await setupAlice();
  const results: Exam3Result[] = []; // 型を明示

  for (const p of PATTERNS) {
    log(`▶️ Pattern ${p.id}: ${p.label}`);
    const testDir = `./tmp_exam3_${p.id}`;
    const zipPath = `${testDir}.zip`;
    await Deno.mkdir(testDir, { recursive: true });

    const files: string[] = []; // 修正箇所: 型を明示
    for (let i = 0; i < p.count; i++) {
      const name = `file_${i}.dat`;
      await createDummyFile(`${testDir}/${name}`, p.size);
      files.push(name);
    }
    await createZip(testDir, zipPath);

    const proj = `exam3-p-${p.id.toLowerCase()}`;
    const ver = "1.0.0";
    await uploadToGwcCsu(testDir, zipPath, 256 * 1024, proj, ver);

    const { durationMs: fetchTime } = await measureTime(async () => {
      const fetches = files.map(async (n) => {
        const r = await fetch(`${CONFIG.GWC_API}/render/${proj}/${ver}/${n}`);
        if (!r.ok) throw new Error(`Fetch fail: ${n}`);
        await r.arrayBuffer();
      });
      await Promise.all(fetches);
    });

    results.push({ pattern: p.id, timeMs: Math.round(fetchTime) });
    await Deno.remove(testDir, { recursive: true });
    await Deno.remove(zipPath);
  }
  await saveResult("exam3_results", results);
}