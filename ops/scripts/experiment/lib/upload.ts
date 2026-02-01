/**
 * lib/upload.ts
 * CSU (Client Side Upload) セッションフローの自動実行
 */
import { runCmd, log } from "./common.ts";
import { CONFIG } from "./config.ts";
import { hashFragmentLeaf, hashFileLeaf, buildMerkleTree } from "./merkle.ts";

export async function uploadToGwc(filePath: string, fragSizeStr: string) {
  const fragSize = parseSize(fragSizeStr);
  const fileName = filePath.split("/").pop() || "test.bin";
  const data = await Deno.readFile(filePath);
  
  log(`📦 Starting CSU flow for ${fileName} (${data.length} bytes)...`);

  // 1. ハッシュ計算とルートプルーフの準備
  const fragments: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += fragSize) {
    fragments.push(data.subarray(i, Math.min(i + fragSize, data.length)));
  }

  const fragLeaves = await Promise.all(
    fragments.map((f, i) => hashFragmentLeaf(fileName, i, f))
  );
  const fileRoot = await buildMerkleTree(fragLeaves);
  const fileLeaf = await hashFileLeaf(fileName, data.length, fileRoot);
  const rootProof = await buildMerkleTree([fileLeaf]);

  let totalGas = 0;

  // 2. Session Initialize
  const initRes = await runGwcTx(["init-session", fragSize.toString(), "0"]);
  const sessionId = extractSessionId(initRes);
  totalGas += initRes.gasUsed;

  // 3. Commit Root Proof
  const commitRes = await runGwcTx(["commit-root-proof", sessionId, rootProof]);
  totalGas += commitRes.gasUsed;

  // 4. Distribute (簡易版: 1バッチで全送信)
  const itemsJsonPath = `./tmp_items_${sessionId}.json`;
  const items = fragments.map((f, i) => ({
    path: fileName,
    index: i,
    fragment_bytes_base64: btoa(String.fromCharCode(...f)),
    fragment_proof: { steps: [] }, // 実験用のため空(keeper側で検証をスキップまたは調整)
    file_size: data.length,
    file_proof: { steps: [] }
  }));
  await Deno.writeTextFile(itemsJsonPath, JSON.stringify({ items }));
  
  const distRes = await runGwcTx(["distribute-batch", sessionId, itemsJsonPath]);
  totalGas += distRes.gasUsed;

  // 5. Finalize
  const manifestPath = `./tmp_manifest_${sessionId}.json`;
  const manifest = {
    project_name: "experiment",
    version: "v1",
    files: [{ path: fileName, size: data.length, root_hash: fileRoot }],
    root_proof: rootProof,
    fragment_size: fragSize,
    owner: "alice", // 実際にはアドレス
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
 * ヘルパー: GWC のトランザクションを実行して結果をパース
 */
async function runGwcTx(args: string[]) {
  const output = await runCmd([
    CONFIG.BIN.GWC, "tx", "gateway", ...args,
    "--from", "alice", "--chain-id", CONFIG.CHAIN_ID,
    "--keyring-backend", "test", "--yes", "--output", "json"
  ]);
  const res = JSON.parse(output);
  return { txHash: res.txhash, gasUsed: parseInt(res.gas_used), raw: res };
}

function parseSize(s: string): number {
  const num = parseInt(s);
  if (s.endsWith("KB")) return num * 1024;
  if (s.endsWith("MB")) return num * 1024 * 1024;
  return num;
}

function extractSessionId(res: any): string {
  // イベントログ等から sessionId を抽出 (実際のイベント定義に依存)
  // 今回は簡易的に logs から抽出するロジックを想定
  return "session-id-placeholder"; 
}