/**
 * lib/upload.ts
 * セッションID取得ロジックの修正およびガス自動計算版
 */
import { encodeBase64 } from "@std/encoding/base64";
import { runCmd, log, toError } from "./common.ts";
import { CONFIG } from "./config.ts";
import { hashFragmentLeaf, hashFileLeaf, combineHashes } from "./merkle.ts";

/**
 * TX Hash がブロックに取り込まれるのを待機し、最新のTX詳細を返す
 */
async function waitForTx(txHash: string): Promise<any> {
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
        return res; // コミット済みの詳細情報を返す
      }
    } catch { /* ignored */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`TX ${txHash} was not committed within ${maxAttempts}s`);
}

/**
 * CSUプロトコルの一連のフローを実行
 */
export async function uploadToGwc(filePath: string, fragSizeStr: string) {
  const fragSize = parseSize(fragSizeStr);
  const data = await Deno.readFile(filePath);
  const fileName = filePath.split("/").pop() || "test.bin";

  log(`📦 Starting CSU flow for ${fileName} (${data.length} bytes)...`);

  // --- ハッシュ計算 ---
  const fragments: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += fragSize) {
    fragments.push(data.subarray(i, Math.min(i + fragSize, data.length)));
  }
  const fragLeaves = await Promise.all(fragments.map((f, i) => hashFragmentLeaf(fileName, i, f)));
  let currentRoot = fragLeaves[0];
  for (let i = 1; i < fragLeaves.length; i++) {
    currentRoot = await combineHashes(currentRoot, fragLeaves[i]);
  }
  const fileLeaf = await hashFileLeaf(fileName, data.length, currentRoot);
  const rootProof = await combineHashes(fileLeaf, fileLeaf);

  let totalGas = 0;

  // --- トランザクション実行 ---

  // 1. Session Initialize
  log("  - Initializing session...");
  const initTx = await runGwcTx(["init-session", fragSize.toString(), "0"]);
  const initRes = await waitForTx(initTx.txHash);
  
  // 重要: チェーンが発行した本物の Session ID を取得
  const sessionId = extractSessionId(initRes);
  if (!sessionId) {
    throw new Error(`Failed to extract session_id from events. TX: ${initTx.txHash}`);
  }
  log(`    ✅ Real Session ID: ${sessionId}`);
  totalGas += parseInt(initRes.gas_used || "0");

  // 2. Commit Root Proof
  log("  - Committing root proof...");
  const commitTx = await runGwcTx(["commit-root-proof", sessionId, rootProof]);
  const commitRes = await waitForTx(commitTx.txHash);
  totalGas += parseInt(commitRes.gas_used || "0");

  // 3. Distribute Batch
  log(`  - Distributing ${fragments.length} fragments...`);
  const itemsJsonPath = `./tmp_items_${sessionId}.json`;
  const items = fragments.map((f, i) => ({
    path: fileName, index: i, fragment_bytes_base64: encodeBase64(f),
    fragment_proof: { steps: [] }, file_size: data.length, file_proof: { steps: [] }
  }));
  await Deno.writeTextFile(itemsJsonPath, JSON.stringify({ items }));
  const distTx = await runGwcTx(["distribute-batch", sessionId, itemsJsonPath]);
  const distRes = await waitForTx(distTx.txHash);
  totalGas += parseInt(distRes.gas_used || "0");

  // 4. Finalize
  log("  - Finalizing session...");
  const manifestPath = `./tmp_manifest_${sessionId}.json`;
  const manifest = {
    project_name: "experiment", version: "v1", files: [{ path: fileName, size: data.length, root_hash: currentRoot }],
    root_proof: rootProof, fragment_size: fragSize, owner: "alice", session_id: sessionId
  };
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));
  const finalTx = await runGwcTx(["finalize-and-close", sessionId, manifestPath]);
  const finalRes = await waitForTx(finalTx.txHash);
  totalGas += parseInt(finalRes.gas_used || "0");

  await Deno.remove(itemsJsonPath);
  await Deno.remove(manifestPath);

  return { txHash: finalTx.txHash, gasUsed: totalGas };
}

/**
 * イベントログから session_id を抽出する (csu_init_session イベントに対応)
 */
function extractSessionId(txDetail: any): string | null {
  try {
    const events = txDetail.events || (txDetail.logs?.[0]?.events) || [];
    for (const event of events) {
      // 修正: Keeper で定義された正確なイベント名 "csu_init_session" を使用
      if (event.type === "csu_init_session") {
        const attr = event.attributes.find((a: any) => 
          a.key === "session_id" || decodeBase64IfPossible(a.key) === "session_id"
        );
        return attr ? (isBase64(attr.value) ? decodeBase64IfPossible(attr.value) : attr.value) : null;
      }
    }
  } catch (e) {
    const err = toError(e);
    log(`⚠️ Error extracting session ID: ${err.message}`);
  }
  return null;
}

function decodeBase64IfPossible(str: string): string {
  try {
    const decoded = atob(str);
    // 制御文字が含まれていなければデコード成功とみなす
    return /^[\x20-\x7E]*$/.test(decoded) ? decoded : str;
  } catch { return str; }
}

function isBase64(str: string): boolean {
  try { return btoa(atob(str)) === str; } catch { return false; }
}

async function runGwcTx(args: string[]) {
  const output = await runCmd([
    CONFIG.BIN.GWC, "tx", "gateway", ...args,
    "--node", CONFIG.GWC_RPC,
    "--from", "alice",
    "--chain-id", "gwc",
    "--keyring-backend", "test",
    "--broadcast-mode", "sync",
    "--gas", "auto",
    "--gas-adjustment", "1.5",
    "--yes",
    "--output", "json"
  ]);
  const res = JSON.parse(output);
  if (res.code !== 0) throw new Error(`TX Submission Error (code ${res.code}): ${res.raw_log}`);
  return { txHash: res.txhash };
}

function parseSize(s: string): number {
  const val = parseInt(s);
  if (s.toUpperCase().endsWith("KB")) return val * 1024;
  if (s.toUpperCase().endsWith("MB")) return val * 1024 * 1024;
  return val;
}