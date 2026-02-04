/**
 * monitor_disk_final.ts
 * 指定された回数の計測を確実に行い、詳細な内訳を含む全データを保存する
 */
import { parseArgs } from "@std/cli/parse-args";
import { log, saveResult } from "./lib/common.ts";
import { getDiskUsage } from "./lib/stats.ts";

/**
 * Podごとのディレクトリサイズ情報を合計バイト数に変換する
 */
function calculateTotalBytes(stats: Record<string, Record<string, number>>): number {
  let total = 0;
  for (const pod in stats) {
    for (const dir in stats[pod]) {
      total += stats[pod][dir];
    }
  }
  return total;
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["duration"],
    default: { duration: "10" },
  });

  // duration を「秒数」兼「目標サンプル数」として扱う
  const targetSamples = parseInt(args.duration);
  log(`📊 ディスク計測開始: ${targetSamples} 回のサンプルを取得します (並列取得モード)`);

  const components = ["gwc", "mdsc", "fdsc"] as const;
  const history: any[] = [];

  // 初回の基準値を取得（増分計算用）
  log("🔍 基準データを取得中...");
  const initialUsageResults = await Promise.all(
    components.map((comp) => getDiskUsage(comp))
  );
  
  const initialTotals: Record<string, number> = {};
  components.forEach((comp, i) => {
    initialTotals[comp] = calculateTotalBytes(initialUsageResults[i]);
  });

  const startTime = Date.now();

  // 時間ではなく「回数」でループを制御し、指定されたデータ数を確保する
  for (let i = 1; i <= targetSamples; i++) {
    const loopStartTime = performance.now();
    const timestamp = new Date().toISOString();
    const snapshot: any = { timestamp, components: {} };

    // 各コンポーネントの計測を並列実行してループ全体の時間を短縮
    const currentUsageResults = await Promise.all(
      components.map((comp) => getDiskUsage(comp))
    );

    components.forEach((comp, idx) => {
      const usage = currentUsageResults[idx];
      const total = calculateTotalBytes(usage);
      
      snapshot.components[comp] = {
        totalBytes: total,
        deltaBytes: total - initialTotals[comp],
        breakdown: usage, // Pod名・ディレクトリ名ごとの全データ
      };
    });

    history.push(snapshot);
    console.log(`[${new Date().toLocaleTimeString()}] 進捗: ${i} / ${targetSamples} サンプル取得済み`);

    // 1秒間隔を維持するための待機処理
    // 計測自体に1秒以上かかった場合は待機せずに次のループへ入る
    const elapsed = performance.now() - loopStartTime;
    const waitTime = Math.max(0, 1000 - elapsed);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  // 結果の保存
  const fileName = `result_monitor_disk_full_${Date.now()}`;
  await saveResult(fileName, {
    config: {
      requestedDuration: targetSamples,
      actualSamples: history.length,
      parallel: true,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date().toISOString(),
    },
    data: history,
  });

  log(`✅ 計測が完了しました。全 ${history.length} 件のデータを results/${fileName}.json に保存しました。`);
}

if (import.meta.main) {
  await main();
}