/**
 * main.ts
 * ポートフォワードをバックグラウンドで管理しながら実験を実行するエントリーポイント
 */
import { parseArgs } from "@std/cli/parse-args";
import { log, toError } from "./lib/common.ts";
import { networkManager } from "./lib/network.ts";
import { runExam1 } from "./cases/exam1.ts";
import { runExam2 } from "./cases/exam2.ts";
import { runExam3 } from "./cases/exam3.ts";

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["case"],
    default: { case: "all" },
  });

  log("🏗️  Cryptomeria Core Experiment Runner Start");

  // ポートフォワード開始
  try {
    await networkManager.start();
  } catch (e) {
    const err = toError(e);
    log(`❌ Failed to start port-forwarding: ${err.message}`);
    Deno.exit(1);
  }

  // 終了時にクリーンアップ
  const cleanup = async () => {
    await networkManager.stop();
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", cleanup);
  Deno.addSignalListener("SIGTERM", cleanup);

  try {
    switch (args.case) {
      case "1":
        await runExam1();
        break;
      case "2":
        await runExam2();
        break;
      case "3":
        await runExam3();
        break;
      case "all":
        log("🔄 Running all experiment cases...");
        await runExam1();
        await runExam2();
        await runExam3();
        break;
      default:
        log(`❌ Unknown case: ${args.case}`);
    }
  } catch (error) {
    const err = toError(error);
    log(`💥 Critical Error during experiments: ${err.message}`);
  } finally {
    await cleanup();
  }
}

if (import.meta.main) {
  await main();
}