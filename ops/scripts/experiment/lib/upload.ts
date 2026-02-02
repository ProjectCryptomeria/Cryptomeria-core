/**
 * lib/upload.ts
 * サーバー側の要件を満たしつつ、重複する権限エラーを適切にハンドルする修正版
 */
import { runCmd, log, toError } from "./common.ts";
import { CONFIG } from "./config.ts";
import { buildProjectMerkleRoot } from "./merkle.ts";
import { crypto } from "@std/crypto";
import { walk } from "@std/fs/walk";
import { relative, resolve } from "@std/path";

/**
 * トランザクションを実行し、コミットされるまで待機します。
 */
async function executeTx(args: string[], from: string) {
  const out = await runCmd([
    CONFIG.BIN.GWC, "tx", ...args,
    "--from", from, "--node", CONFIG.GWC_RPC, "--chain-id", CONFIG.CHAIN_ID,
    "--keyring-backend", "test", "--gas", "auto", "--gas-adjustment", "1.5", "-y", "-o", "json"
  ]);
  const res = JSON.parse(out);
  log(`  - TX Sent: ${res.txhash} (Waiting commit...)`);

  await new Promise(r => setTimeout(r, 6500));

  const q = await runCmd([CONFIG.BIN.GWC, "q", "tx", res.txhash, "--node", CONFIG.GWC_RPC, "-o", "json"]);
  const qRes = JSON.parse(q);
  if (qRes.code !== 0) {
    throw new Error(`TX failed with code ${qRes.code}: ${qRes.raw_log}`);
  }
  return qRes;
}

/**
 * GWCに対してアップロードを実行します。
 */
export async function uploadToGwcCsu(sourceDir: string, zipPath: string, fragSize: number, projectName: string, version: string) {
  log(`Step 1: Scanning directory "${sourceDir}" for Merkle Root computation...`);
  const files: { path: string, data: Uint8Array }[] = [];
  const absSourceDir = resolve(sourceDir);

  for await (const entry of walk(sourceDir, { includeDirs: false })) {
    const absEntryPath = resolve(entry.path);
    const relPath = relative(absSourceDir, absEntryPath);
    const data = await Deno.readFile(entry.path);
    files.push({ path: relPath, data });
  }

  // Merkle Root 計算 (サーバー仕様: 空ファイルをスキップ)
  const rootHex = await buildProjectMerkleRoot(files, fragSize);
  log(`  - Final Computed Merkle Root: ${rootHex}`);

  // 2. Session Init
  log("Step 2: Initializing Session...");
  const initRes = await executeTx(["gateway", "init-session", fragSize.toString(), "0"], "alice");
  const event = initRes.events.find((e: any) => e.type === "csu_init_session");
  const sid = event.attributes.find((a: any) => a.key === "session_id").value;
  const exec = event.attributes.find((a: any) => a.key === "executor").value;
  const owner = event.attributes.find((a: any) => a.key === "owner").value;
  log(`  - Session ID: ${sid}`);

  // 3. Granting Permissions
  log("Step 3: Granting Permissions (Handling existing grants)...");

  // FeeGrant: すでに存在する場合はエラーを無視する
  try {
    await executeTx(["feegrant", "grant", owner, exec], "alice");
  } catch (err) {
    const e = toError(err);
    if (e.message.includes("already exists")) {
      log("  - Fee allowance already exists, skipping...");
    } else {
      throw e;
    }
  }

  const msgTypes = [
    "MsgDistributeBatch",
    "MsgFinalizeAndCloseSession",
    "MsgAbortAndCloseSession"
  ];

  for (const m of msgTypes) {
    const msgTypeUrl = `/gwc.gateway.v1.${m}`;
    log(`  - Granting authz for ${m}`);
    try {
      // サーバー側のバリデーションを通すため GenericAuthorization を使用
      await executeTx(["authz", "grant", exec, "generic", "--msg-type", msgTypeUrl], "alice");
    } catch (err) {
      const e = toError(err);
      // Authzも念のため重複エラーをハンドルする
      if (e.message.includes("already exists")) {
        log(`  - Authz for ${m} already exists, skipping...`);
      } else {
        throw e;
      }
    }
  }

  // 4. Merkle Commit
  log("Step 4: Committing Merkle Root...");
  await executeTx(["gateway", "commit-root-proof", sid, rootHex], "alice");

  // 5. TUS Upload
  log(`Step 5: TUS Uploading ZIP: ${zipPath}`);
  const zipData = await Deno.readFile(zipPath);

  // サーバー側のトークン生成ロジック: sha256("upload_token:" + sessionID)
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

  if (!post.ok) {
    throw new Error(`TUS POST failed: ${await post.text()}`);
  }

  const loc = post.headers.get("Location")!;
  const patchUrl = loc.startsWith("http") ? loc : `${CONFIG.GWC_API}${loc}`;

  const patch = await fetch(patchUrl, {
    method: "PATCH",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Content-Type": "application/offset+octet-stream",
      "Upload-Offset": "0"
    },
    body: zipData
  });

  if (patch.status !== 204) {
    throw new Error(`TUS PATCH failed: ${await patch.text()}`);
  }

  // 6. Verification
  log("Step 6: Verifying Session State...");
  for (let i = 0; i < 30; i++) {
    const q = await runCmd([CONFIG.BIN.GWC, "q", "gateway", "session", sid, "--node", CONFIG.GWC_RPC, "-o", "json"]);
    const sessionData = JSON.parse(q).session;
    const state = sessionData.state;

    log(`  - Current State: ${state}`);
    if (state === "SESSION_STATE_CLOSED_SUCCESS") {
      log("✅ Upload and Verification Successful!");
      return { sid };
    }
    if (state === "SESSION_STATE_CLOSED_FAILED") {
      throw new Error(`On-chain Error: ${sessionData.close_reason}`);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error("Session verification timeout");
}