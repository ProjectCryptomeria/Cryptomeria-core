/**
 * cases/exam2.ts
 * バッチサイズ（断片サイズ）実験
 * アップロードサイズを512KBに固定し、断片サイズを変動させて性能を評価します。
 */
import { log, saveResult } from "../lib/common.ts";
import { setupAlice } from "../lib/initialize.ts";
import { createDummyFile } from "../lib/file.ts";
import { getDiskUsage, measureTime } from "../lib/stats.ts";
import { uploadToGwc } from "../lib/upload.ts";

/**
 * 実験2のシナリオ定義
 */
const SCENARIOS = [
  { step: 1, fragSize: "256KB", label: "基準値 (MAXサイズ)" },
  { step: 2, fragSize: "171KB", label: "中途半端な分割" },
  { step: 3, fragSize: "128KB", label: "MAXの半分" },
  { step: 4, fragSize: "64KB", label: "リクエスト回数倍増" },
  { step: 5, fragSize: "32KB", label: "低下傾向確認" },
  { step: 6, fragSize: "8KB", label: "高負荷（パケットサイズ近傍）" },
  { step: 7, fragSize: "1KB", label: "限界値（固定コスト算出）" },
];

const FIXED_UPLOAD_SIZE = 512 * 1024; // 512 KB

export async function runExam2() {
  log("🧪 Starting Exam 2: Batch Size Experiment");
  
  // 1. 前準備: アカウントとテストファイルの作成
  const alice = await setupAlice();
  const testFilePath = "./tmp_exam2_fixed.bin";
  await createDummyFile(testFilePath, FIXED_UPLOAD_SIZE);

  const results = [];

  for (const s of SCENARIOS) {
    log(`▶️ Step ${s.step}: Fragment Size = ${s.fragSize} (${s.label})`);

    // 計測開始前のディスク使用量（FDSCを対象）
    const diskBefore = await getDiskUsage("fdsc");

    // 2. アップロード実行 (前処理とアップロードを分離計測)
    // ※ ここでの前処理は、認証や内部的な分割ロジックのオーバーヘッドを想定
    const { result, durationMs: uploadTime } = await measureTime(async () => {
      return await uploadToGwc(testFilePath, s.fragSize);
    });

    // 計測終了後のディスク使用量
    const diskAfter = await getDiskUsage("fdsc");
    const actualIncrease = diskAfter - diskBefore;

    const resultData = {
      step: s.step,
      fragmentSize: s.fragSize,
      description: s.label,
      uploadTimeMs: uploadTime,
      gasUsed: result.gasUsed,
      diskUsageBefore: diskBefore,
      diskUsageAfter: diskAfter,
      diskIncrease: actualIncrease,
      overheadRatio: (actualIncrease / FIXED_UPLOAD_SIZE).toFixed(4),
    };

    log(`⏱️ Upload Time: ${uploadTime}ms, ⛽ Gas Used: ${result.gasUsed}`);
    log(`💾 Disk Increase: ${actualIncrease} bytes (Overhead: ${resultData.overheadRatio}x)`);
    
    results.push(resultData);
  }

  // 結果の保存
  await saveResult("exam2_batch_size_report", {
    fixed_size_bytes: FIXED_UPLOAD_SIZE,
    timestamp: new Date().toISOString(),
    scenarios: results,
  });
}