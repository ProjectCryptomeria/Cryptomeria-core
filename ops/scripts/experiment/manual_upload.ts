/**
 * manual_upload_with_stats.ts
 * ポートフォワードを自動管理しながら、任意のファイルをアップロードし、
 * 実験1と同様のメトリクスとディスク増分を記録・保存する。
 */
import { parseArgs } from "jsr:@std/cli/parse-args";
import { join, basename } from "jsr:@std/path";
import { ensureDir } from "jsr:@std/fs/ensure-dir";

import { log, toError } from "./lib/common.ts";
import { networkManager } from "./lib/network.ts"; // ポートフォワード管理
import { setupAlice } from "./lib/initialize.ts";
import { createZip } from "./lib/file.ts";
import { getDiskUsage } from "./lib/stats.ts";
import { uploadToGwcCsu } from "./lib/upload.ts";

const FRAG_SIZE = 254 * 1024;

/**
 * Podごとのディレクトリサイズを合計バイト数に変換
 */
function sumUsage(podUsage: Record<string, Record<string, number>>): number {
  let total = 0;
  for (const pod in podUsage) {
    for (const dir in podUsage[pod]) {
      total += podUsage[pod][dir];
    }
  }
  return total;
}

/**
 * Podごとの詳細な増分を計算
 */
function calcDiskDelta(
  before: Record<string, Record<string, number>>,
  after: Record<string, Record<string, number>>
): Record<string, Record<string, number>> {
  const delta: Record<string, Record<string, number>> = {};
  for (const podName in after) {
    delta[podName] = {};
    const beforePod = before[podName] || {};
    for (const dirName in after[podName]) {
      delta[podName][dirName] = after[podName][dirName] - (beforePod[dirName] || 0);
    }
  }
  return delta;
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["path", "project", "version"],
    alias: { p: "path", n: "project", v: "version" },
  });

  const targetPath = args.path;
  const projectName = args.project || "manual-project";
  const version = args.version || "1.0.0";

  if (!targetPath) {
    console.error("使用法: deno run -A manual_upload_with_stats.ts --path <対象パス> [--project <名>] [--version <版>]");
    Deno.exit(1);
  }

  log("🏗️  Cryptomeria Core Manual Upload with Network Management Start");

  // 1. ポートフォワード開始
  try {
    await networkManager.start();
  } catch (e) {
    const err = toError(e);
    log(`❌ Failed to start port-forwarding: ${err.message}`);
    Deno.exit(1);
  }

  // 終了・割り込み時のクリーンアップ関数
  const cleanup = async () => {
    log("🧹 Cleaning up network connections...");
    await networkManager.stop();
  };

  // シグナルリスナーの設定
  Deno.addSignalListener("SIGINT", async () => {
    await cleanup();
    Deno.exit(0);
  });

  try {
    // 2. 環境準備
    await setupAlice();
    log(`🧪 手動計測アップロード: ${targetPath}`);

    const stats = await Deno.stat(targetPath);
    let sourceDir: string;
    let needsCleanup = false;

    if (stats.isDirectory) {
      sourceDir = targetPath;
    } else {
      const tempDir = await Deno.makeTempDir({ prefix: "manual_stats_" });
      await Deno.copyFile(targetPath, join(tempDir, basename(targetPath)));
      sourceDir = tempDir;
      needsCleanup = true;
    }

    const zipPath = `${projectName}_${version}.zip`;
    await createZip(sourceDir, zipPath);
    const zipSize = (await Deno.stat(zipPath)).size;

    // --- 実行前のディスク容量取得 (Pod別) ---
    const diskBefore = {
      gwc: await getDiskUsage("gwc"),
      mdsc: await getDiskUsage("mdsc"),
      fdsc: await getDiskUsage("fdsc"),
    };

    // --- アップロード実行 ---
    const { sid, metrics } = await uploadToGwcCsu(sourceDir, zipPath, FRAG_SIZE, projectName, version);

    // --- 実行後のディスク容量取得 (Pod別) ---
    const diskAfter = {
      gwc: await getDiskUsage("gwc"),
      mdsc: await getDiskUsage("mdsc"),
      fdsc: await getDiskUsage("fdsc"),
    };

    const totalDelta = {
      gwc: sumUsage(diskAfter.gwc) - sumUsage(diskBefore.gwc),
      mdsc: sumUsage(diskAfter.mdsc) - sumUsage(diskBefore.mdsc),
      fdsc: sumUsage(diskAfter.fdsc) - sumUsage(diskBefore.fdsc),
    };

    // データの構築
    const result = {
      scenario: "manual",
      label: "Manual Upload with Stats",
      inputSize: zipSize,
      metrics: metrics,
      diskDeltaTotal: {
        ...totalDelta,
        sum: totalDelta.gwc + totalDelta.mdsc + totalDelta.fdsc
      },
      diskBreakdownDelta: {
        gwc: calcDiskDelta(diskBefore.gwc, diskAfter.gwc),
        mdsc: calcDiskDelta(diskBefore.mdsc, diskAfter.mdsc),
        fdsc: calcDiskDelta(diskBefore.fdsc, diskAfter.fdsc),
      },
      overheadRatio: (totalDelta.fdsc / zipSize).toFixed(3),
      sid: sid,
      timestamp: Date.now()
    };

    // 結果の保存
    const resultsDir = "./results";
    await ensureDir(resultsDir);
    const fileName = `manual_${projectName}_${version}_${Date.now()}.json`;
    const filePath = join(resultsDir, fileName);
    
    await Deno.writeTextFile(filePath, JSON.stringify(result, null, 2));
    log(`✅ 実験データを保存しました: ${filePath}`);

    // ファイルの後処理
    await Deno.remove(zipPath);
    if (needsCleanup) await Deno.remove(sourceDir, { recursive: true });

  } catch (error) {
    const err = toError(error);
    log(`💥 Critical Error: ${err.message}`);
  } finally {
    // 3. ポートフォワード停止
    await cleanup();
  }
}

if (import.meta.main) {
  await main();
}