/**
 * lib/upload.ts
 * 計測要件に基づき、フェーズごとの実行時間を計測するように拡張
 */
import { runCmd, log } from "./common.ts";
import { CONFIG } from "./config.ts";
import { buildProjectMerkleRoot } from "./merkle.ts";
import { crypto } from "@std/crypto";
import { walk } from "@std/fs/walk";
import { relative, resolve } from "@std/path";

export interface UploadMetrics {
  prepTimeMs: number;    // ディレクトリ走査・マークル計算
  uploadTimeMs: number;  // セッション初期化・Authz・TUS通信
  verifyTimeMs: number;  // オンチェーン検証完了待ち
}

async function executeTx(args: string[], from: string) {
  const out = await runCmd([
    CONFIG.BIN.GWC, "tx", ...args,
    "--from", from, "--node", CONFIG.GWC_RPC, "--chain-id", CONFIG.CHAIN_ID,
    "--keyring-backend", "test", "--gas", "auto", "--gas-adjustment", "1.5", "-y", "-o", "json"
  ]);
  const res = JSON.parse(out);
  await new Promise(r => setTimeout(r, 6500));
  const q = await runCmd([CONFIG.BIN.GWC, "q", "tx", res.txhash, "--node", CONFIG.GWC_RPC, "-o", "json"]);
  const qRes = JSON.parse(q);
  if (qRes.code !== 0) throw new Error(`TX failed: ${qRes.raw_log}`);
  return qRes;
}

export async function uploadToGwcCsu(
  sourceDir: string,
  zipPath: string,
  fragSize: number,
  projectName: string,
  version: string
): Promise<{ sid: string, metrics: UploadMetrics }> {

  // --- Phase 1: Preparation ---
  const startPrep = performance.now();
  log(`Step 1: Scanning directory "${sourceDir}"...`);
  const files: { path: string, data: Uint8Array }[] = [];
  const absSourceDir = resolve(sourceDir);

  for await (const entry of walk(sourceDir, { includeDirs: false })) {
    const relPath = relative(absSourceDir, resolve(entry.path));
    const data = await Deno.readFile(entry.path);
    files.push({ path: relPath, data });
  }

  const rootHex = await buildProjectMerkleRoot(files, fragSize);
  const endPrep = performance.now();

  // --- Phase 2: Upload Process ---
  const startUpload = performance.now();
  log("Step 2: Initializing Session...");
  const initRes = await executeTx(["gateway", "init-session", fragSize.toString(), "0"], "alice");
  const event = initRes.events.find((e: any) => e.type === "csu_init_session");
  const sid = event.attributes.find((a: any) => a.key === "session_id").value;
  const exec = event.attributes.find((a: any) => a.key === "executor").value;
  const owner = event.attributes.find((a: any) => a.key === "owner").value;

  log("Step 3: Granting Permissions...");
  try {
    await executeTx(["feegrant", "grant", owner, exec], "alice");
  } catch (e) { /* すでに存在する場合は無視 */ }

  for (const m of ["MsgDistributeBatch", "MsgFinalizeAndCloseSession", "MsgAbortAndCloseSession"]) {
    try {
      await executeTx(["authz", "grant", exec, "generic", "--msg-type", `/gwc.gateway.v1.${m}`], "alice");
    } catch (e) { /* すでに存在する場合は無視 */ }
  }

  log("Step 4: Committing Merkle Root...");
  await executeTx(["gateway", "commit-root-proof", sid, rootHex], "alice");

  log(`Step 5: TUS Uploading ZIP: ${zipPath}`);
  const zipData = await Deno.readFile(zipPath);
  const tokenRaw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`upload_token:${sid}`));
  const token = Array.from(new Uint8Array(tokenRaw)).map(b => b.toString(16).padStart(2, "0")).join("");

  const meta = `session_id ${btoa(sid)},project_name ${btoa(projectName)},version ${btoa(version)}`;
  const post = await fetch(`${CONFIG.GWC_API}/upload/tus-stream`, {
    method: "POST",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": zipData.length.toString(),
      "Upload-Metadata": meta,
      "Authorization": `Bearer ${token}`
    }
  });

  const loc = post.headers.get("Location")!;
  const patchUrl = loc.startsWith("http") ? loc : `${CONFIG.GWC_API}${loc}`;
  await fetch(patchUrl, {
    method: "PATCH",
    headers: { "Tus-Resumable": "1.0.0", "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0" },
    body: zipData
  });
  const endUpload = performance.now();

  // --- Phase 3: On-chain Verification ---
  const startVerify = performance.now();
  log("Step 6: Verifying Session State...");
  let finalSid = sid;
  for (let i = 0; i < 40; i++) {
    const q = await runCmd([CONFIG.BIN.GWC, "q", "gateway", "session", sid, "--node", CONFIG.GWC_RPC, "-o", "json"]);
    const state = JSON.parse(q).session.state;
    if (state === "SESSION_STATE_CLOSED_SUCCESS") {
      const endVerify = performance.now();
      return {
        sid: finalSid,
        metrics: {
          prepTimeMs: Math.round(endPrep - startPrep),
          uploadTimeMs: Math.round(endUpload - startUpload),
          verifyTimeMs: Math.round(endVerify - startVerify),
        }
      };
    }
    if (state === "SESSION_STATE_CLOSED_FAILED") throw new Error("Verification failed on-chain");
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error("Verification timeout");
}