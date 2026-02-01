/**
 * main.ts
 * 実験用スクリプトのエントリーポイント。
 * コマンドライン引数に基づいて各実験ケースを実行します。
 */
import { parseArgs } from "@std/cli/parse-args";
import { log, toError } from "./lib/common.ts";
import { runExam1 } from "./cases/exam1.ts";
import { runExam2 } from "./cases/exam2.ts";
import { runExam3 } from "./cases/exam3.ts";

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["case"],
    default: { case: "all" },
  });

  log("🏗️  Cryptomeria Core Experiment Runner Start");

  try {
    switch (args.case) {
      case "1":
        log("🚀 Starting Case 1...");
        await runExam1();
        break;
      case "2":
        log("🚀 Starting Case 2...");
        await runExam2();
        break;
      case "3":
        log("🚀 Starting Case 3...");
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
        Deno.exit(1);
    }
    log("✅ All requested experiments completed successfully.");
  } catch (error) {
    const err = toError(error);
    log(`💥 Critical Error during experiments: ${err.message}`);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}