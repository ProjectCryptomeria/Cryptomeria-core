/**
 * lib/upload.ts
 * CSU (Client Side Upload) プロトコル準拠 & ガス自動計算版
 */
import { encodeBase64 } from "@std/encoding/base64";
import { runCmd, log } from "./common.ts";
import { CONFIG } from "./config.ts";
import { hashFragmentLeaf, hashFileLeaf, combineHashes } from "./merkle.ts";

/**
 * 指定された TX Hash がブロックに取り込まれたか確認する
 */
async function waitForTx(txHash: string): Promise<void> {
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const output = await runCmd([
        CONFIG.BIN.GWC, "q", "tx", txHash,
        "--node", CONFIG.GWC_RPC,
        "--output", "json"
      ]);
      const res = JSON.parse(output);
      if (res && res.txhash === txHash) {
        return;
      }
    } catch {
      // ログがうるさくならないよう待機のみ
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`TX ${txHash} was not committed within ${maxAttempts}s`);
}

/**
 * CSUプロトコルの一連のフローを安全に実行
 */
export async function uploadToGwc(filePath: string, fragSizeStr: string) {
  const fragSize = parseSize(fragSizeStr);
  const data = await Deno.readFile(filePath);
  const fileName = filePath.split("/").pop() || "test.bin";

  log(`📦 Starting CSU flow for ${fileName} (${data.length} bytes)...`);

  // ハッシュ計算
  const fragments: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += fragSize) {
    fragments.push(data.subarray(i, Math.min(i + fragSize, data.length)));
  }

  const fragLeaves = await Promise.all(
    fragments.map((f, i) => hashFragmentLeaf(fileName, i, f))
  );

  let currentRoot = fragLeaves[0];
  for (let i = 1; i < fragLeaves.length; i++) {
    currentRoot = await combineHashes(currentRoot, fragLeaves[i]);
  }
  
  const fileLeaf = await hashFileLeaf(fileName, data.length, currentRoot);
  const rootProof = await combineHashes(fileLeaf, fileLeaf);

  let totalGas = 0;

  // --- トランザクション・フロー ---

  // 1. Session Initialize
  log("  - Initializing session...");
  const initRes = await runGwcTx(["init-session", fragSize.toString(), "0"]);
  await waitForTx(initRes.txHash);
  
  const sessionId = extractSessionId(initRes.raw) || `session_${Date.now()}`;
  totalGas += initRes.gasUsed;

  // 2. Commit Root Proof
  log("  - Committing root proof...");
  const commitRes = await runGwcTx(["commit-root-proof", sessionId, rootProof]);
  await waitForTx(commitRes.txHash);
  totalGas += commitRes.gasUsed;

  // 3. Distribute Batch
  log(`  - Distributing ${fragments.length} fragments...`);
  const itemsJsonPath = `./tmp_items_${sessionId}.json`;
  const items = fragments.map((f, i) => ({
    path: fileName,
    index: i,
    fragment_bytes_base64: encodeBase64(f),
    fragment_proof: { steps: [] }, 
    file_size: data.length,
    file_proof: { steps: [] }
  }));
  await Deno.writeTextFile(itemsJsonPath, JSON.stringify({ items }));
  
  const distRes = await runGwcTx(["distribute-batch", sessionId, itemsJsonPath]);
  await waitForTx(distRes.txHash);
  totalGas += distRes.gasUsed;

  // 4. Finalize
  log("  - Finalizing session...");
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
  await waitForTx(finalRes.txHash); 
  totalGas += finalRes.gasUsed;

  await Deno.remove(itemsJsonPath);
  await Deno.remove(manifestPath);

  return { txHash: finalRes.txHash, gasUsed: totalGas };
}

/**
 * GWC TX 実行ヘルパー
 * --gas auto と --gas-adjustment を追加して Out of gas を防止
 */
async function runGwcTx(args: string[]) {
  const output = await runCmd([
    CONFIG.BIN.GWC, "tx", "gateway", ...args,
    "--node", CONFIG.GWC_RPC,
    "--from", "alice",
    "--chain-id", "gwc",
    "--keyring-backend", "test",
    "--broadcast-mode", "sync",
    "--gas", "auto",           // ガスを自動計算
    "--gas-adjustment", "1.5", // 計算されたガスに余裕(1.5倍)を持たせる
    "--yes",
    "--output", "json"
  ]);
  
  const res = JSON.parse(output);
  if (res.code !== 0) {
    throw new Error(`TX Error (code ${res.code}): ${res.raw_log}`);
  }
  return {
    txHash: res.txhash,
    gasUsed: parseInt(res.gas_used || "0"),
    raw: res
  };
}

function parseSize(s: string): number {
  const val = parseInt(s);
  if (s.toUpperCase().endsWith("KB")) return val * 1024;
  if (s.toUpperCase().endsWith("MB")) return val * 1024 * 1024;
  return val;
}

function extractSessionId(txRaw: any): string | null {
  try {
    const events = txRaw.logs?.[0]?.events || [];
    for (const event of events) {
      if (event.type === "session_initialized") {
        return event.attributes.find((a: any) => a.key === "session_id")?.value;
      }
    }
  } catch { /* ignore */ }
  return null;
}