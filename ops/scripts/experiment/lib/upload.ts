/**
 * lib/upload.ts
 * CSU (Client Side Upload) セッションフローの自動実行
 */
import { runCmd, log, toError } from "./common.ts";
import { CONFIG } from "./config.ts";
import { hashFragmentLeaf, hashFileLeaf, combineHashes } from "./merkle.ts";

/**
 * CSUプロトコルに基づいた一連のアップロード処理を実行
 */
export async function uploadToGwc(filePath: string, fragSizeStr: string) {
  const fragSize = parseSize(fragSizeStr);
  const data = await Deno.readFile(filePath);
  const fileName = filePath.split("/").pop() || "test.bin";

  log(`📦 Starting CSU flow for ${fileName} (${data.length} bytes)...`);

  // --- [1. 前処理: ハッシュ計算] ---
  // 本来はここでマークルプルーフを構築するが、実験用としてルートハッシュの計算のみ行う
  const fragments: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += fragSize) {
    fragments.push(data.subarray(i, Math.min(i + fragSize, data.length)));
  }

  const fragLeaves = await Promise.all(
    fragments.map((f, i) => hashFragmentLeaf(fileName, i, f))
  );

  // 簡易的なルート計算 (merkle.ts のロジックに準拠)
  let currentRoot = fragLeaves[0];
  for (let i = 1; i < fragLeaves.length; i++) {
    currentRoot = await combineHashes(currentRoot, fragLeaves[i]);
  }
  
  const fileLeaf = await hashFileLeaf(fileName, data.length, currentRoot);
  const rootProof = await combineHashes(fileLeaf, fileLeaf); // ダミーのRootProof

  let totalGas = 0;

  // --- [2. TX実行フェーズ] ---
  
  // A. Session Initialize
  log("  - Initializing session...");
  const initRes = await runGwcTx(["init-session", fragSize.toString(), "0"]);
  // イベントログから sessionId を抽出 (※環境により位置が異なるため、固定値またはパースが必要)
  // ここでは実験継続のため、ダミーまたは固定の命名規則を想定
  const sessionId = `session_${Date.now()}`; 
  totalGas += initRes.gasUsed;

  // B. Commit Root Proof
  log("  - Committing root proof...");
  const commitRes = await runGwcTx(["commit-root-proof", sessionId, rootProof]);
  totalGas += commitRes.gasUsed;

  // C. Distribute Batch (全断片を一括送信)
  log(`  - Distributing ${fragments.length} fragments...`);
  const itemsJsonPath = `./tmp_items_${sessionId}.json`;
  const items = fragments.map((f, i) => ({
    path: fileName,
    index: i,
    fragment_bytes_base64: btoa(String.fromCharCode(...f)),
    fragment_proof: { steps: [] }, 
    file_size: data.length,
    file_proof: { steps: [] }
  }));
  await Deno.writeTextFile(itemsJsonPath, JSON.stringify({ items }));
  
  const distRes = await runGwcTx(["distribute-batch", sessionId, itemsJsonPath]);
  totalGas += distRes.gasUsed;

  // D. Finalize
  log("  - Finalizing and closing session...");
  const manifestPath = `./tmp_manifest_${sessionId}.json`;
  const manifest = {
    project_name: "experiment",
    version: "v1",
    files: [{ path: fileName, size: data.length, root_hash: currentRoot }],
    root_proof: rootProof,
    fragment_size: fragSize,
    owner: "alice",
    session_id: sessionId
  };
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));

  const finalRes = await runGwcTx(["finalize-and-close", sessionId, manifestPath]);
  totalGas += finalRes.gasUsed;

  // クリーンアップ
  await Deno.remove(itemsJsonPath);
  await Deno.remove(manifestPath);

  return { txHash: finalRes.txHash, gasUsed: totalGas };
}

/**
 * 修正ポイント: --node フラグを追加
 */
async function runGwcTx(args: string[]) {
  const output = await runCmd([
    CONFIG.BIN.GWC, "tx", "gateway", ...args,
    "--node", CONFIG.GWC_RPC, // ポート 30007 を見に行くように指定
    "--from", "alice",
    "--chain-id", CONFIG.CHAIN_ID,
    "--keyring-backend", "test",
    "--yes",
    "--output", "json"
  ]);
  
  try {
    const res = JSON.parse(output);
    return {
      txHash: res.txhash,
      gasUsed: parseInt(res.gas_used || "0"),
    };
  } catch (e) {
    const err = toError(e);
    throw new Error(`Failed to parse JSON output: ${output}\n${err.message}`);
  }
}

function parseSize(s: string): number {
  const val = parseInt(s);
  if (s.toUpperCase().endsWith("KB")) return val * 1024;
  if (s.toUpperCase().endsWith("MB")) return val * 1024 * 1024;
  return val;
}