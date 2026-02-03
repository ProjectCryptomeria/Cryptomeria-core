/**
 * lib/upload.ts
 * 実験のフェーズごとの実行時間（準備、アップロード、デプロイ、フェッチ）を計測。
 * Account Sequence Mismatch および Query Lag への対策（リトライロジック）を強化。
 */
import { runCmd, log } from "./common.ts";
import { CONFIG } from "./config.ts";
import { buildProjectMerkleRoot } from "./merkle.ts";
import { crypto } from "@std/crypto";
import { walk } from "@std/fs/walk";
import { relative, resolve } from "@std/path";

export interface UploadMetrics {
  prepTimeMs: number;
  clientUploadTimeMs: number;
  deployTimeMs: number;
  fetchTimeMs: number;
}

/**
 * Cosmos SDKのトランザクションを実行し、成功を待機する内部関数。
 * シーケンス不一致やクエリ遅延に対するリトライロジックを含む。
 */
async function executeTx(args: string[], from: string): Promise<any> {
  const MAX_ATTEMPTS = 5;
  let lastError: any;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // 1. トランザクションのブロードキャスト
      const out = await runCmd([
        CONFIG.BIN.GWC,
        "tx",
        ...args,
        "--from",
        from,
        "--node",
        CONFIG.GWC_RPC,
        "--chain-id",
        CONFIG.CHAIN_ID,
        "--keyring-backend",
        "test",
        "--gas",
        "auto",
        "--gas-adjustment",
        "1.5",
        "-y",
        "-o",
        "json",
      ]);
      const res = JSON.parse(out);

      // 2. トランザクションがブロックに取り込まれるまでクエリをリトライ
      for (let q = 0; q < 15; q++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const qOut = await runCmd([
            CONFIG.BIN.GWC,
            "q",
            "tx",
            res.txhash,
            "--node",
            CONFIG.GWC_RPC,
            "-o",
            "json",
          ]);
          const qRes = JSON.parse(qOut);
          if (qRes.code !== 0)
            throw new Error(`TX failed on chain: ${qRes.raw_log}`);
          return qRes; // 成功
        } catch (e) {
          if (q === 14) throw e;
          // 'not found' の場合はループを継続
        }
      }
    } catch (e) {
      lastError = e;
      const errMsg = String(e);
      // シーケンス番号の不一致、または Tx が既知の場合のリトライ
      if (
        errMsg.includes("account sequence mismatch") ||
        errMsg.includes("tx already exists")
      ) {
        log(
          `    (警告: シーケンス不一致のためリトライ中... ${attempt}/${MAX_ATTEMPTS})`,
        );
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw e; // それ以外の重大なエラーは即中断
    }
  }
  throw new Error(
    `TX execution failed after ${MAX_ATTEMPTS} attempts: ${lastError}`,
  );
}

async function hasFeegrant(owner: string, exec: string): Promise<boolean> {
  try {
    const out = await runCmd([
      CONFIG.BIN.GWC,
      "q",
      "feegrant",
      "grant",
      owner,
      exec,
      "--node",
      CONFIG.GWC_RPC,
      "-o",
      "json",
    ]);
    const data = JSON.parse(out);
    return !!(data.allowance || data.grant);
  } catch (_e) {
    return false;
  }
}

async function hasAuthz(
  owner: string,
  exec: string,
  msgType: string,
): Promise<boolean> {
  try {
    const out = await runCmd([
      CONFIG.BIN.GWC,
      "q",
      "authz",
      "grants",
      owner,
      exec,
      "--node",
      CONFIG.GWC_RPC,
      "-o",
      "json",
    ]);
    const data = JSON.parse(out);
    if (!data.grants || !Array.isArray(data.grants)) return false;
    return data.grants.some(
      (g: any) =>
        g.authorization?.msg === msgType ||
        (g.authorization?.["@type"]?.includes("GenericAuthorization") &&
          g.authorization?.msg === msgType),
    );
  } catch (_e) {
    return false;
  }
}

export async function uploadToGwcCsu(
  sourceDir: string,
  zipPath: string,
  fragSize: number,
  projectName: string,
  version: string,
): Promise<{ sid: string; metrics: UploadMetrics }> {
  const startPrep = performance.now();
  log(`Step 1: ディレクトリの走査中: "${sourceDir}"...`);
  const files: { path: string; data: Uint8Array }[] = [];
  const absSourceDir = resolve(sourceDir);
  let firstFilePath = "";

  for await (const entry of walk(sourceDir, { includeDirs: false })) {
    const relPath = relative(absSourceDir, resolve(entry.path));
    if (!firstFilePath) firstFilePath = relPath;
    const data = await Deno.readFile(entry.path);
    files.push({ path: relPath, data });
  }

  const rootHex = await buildProjectMerkleRoot(files, fragSize);

  log("Step 2: セッションの初期化中...");
  const initRes = await executeTx(
    ["gateway", "init-session", fragSize.toString(), "0"],
    "alice",
  );

  const event = initRes.events.find((e: any) => e.type === "csu_init_session");
  const sid = (
    event.attributes.find((a: any) => a.key === "session_id").value as string
  ).replace(/^"|"$/g, "");
  const exec = (
    event.attributes.find((a: any) => a.key === "executor").value as string
  ).replace(/^"|"$/g, "");
  const owner = (
    event.attributes.find((a: any) => a.key === "owner").value as string
  ).replace(/^"|"$/g, "");

  log(`Step 3: 権限（Authz/Feegrant）の確認と設定中...`);

  const expirationDate = new Date();
  expirationDate.setHours(expirationDate.getHours() + 1);
  const expirationISO = expirationDate.toISOString().replace(/\.\d{3}Z$/, "Z");
  const expirationUnix = Math.floor(expirationDate.getTime() / 1000).toString();

  if (!(await hasFeegrant(owner, exec))) {
    try {
      log("  - Feegrant を付与中...");
      await executeTx(
        ["feegrant", "grant", owner, exec, "--expiration", expirationISO],
        "alice",
      );
    } catch (e) {
      if (!String(e).includes("already exists"))
        log(`  - Feegrant付与失敗: ${e}`);
    }
  } else {
    log("  - Feegrant は既に設定済みです。");
  }

  const msgTypes = [
    "MsgDistributeBatch",
    "MsgFinalizeAndCloseSession",
    "MsgAbortAndCloseSession",
  ];
  for (const m of msgTypes) {
    const typeUrl = `/gwc.gateway.v1.${m}`;
    if (!(await hasAuthz(owner, exec, typeUrl))) {
      try {
        log(`  - Authz (${m}) を付与中...`);
        await executeTx(
          [
            "authz",
            "grant",
            exec,
            "generic",
            "--msg-type",
            typeUrl,
            "--expiration",
            expirationUnix,
          ],
          "alice",
        );
      } catch (e) {
        if (!String(e).includes("already exists"))
          log(`  - Authz(${m})付与失敗: ${e}`);
      }
    } else {
      log(`  - Authz (${m}) は既に設定済みです。`);
    }
  }

  log("Step 4: マークルルートのコミット中...");
  await executeTx(["gateway", "commit-root-proof", sid, rootHex], "alice");

  const zipData = await Deno.readFile(zipPath);
  const tokenRaw = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`upload_token:${sid}`),
  );
  const token = Array.from(new Uint8Array(tokenRaw))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const endPrep = performance.now();

  // --- Phase 2: Client Upload ---
  const startClientUpload = performance.now();
  log(`Step 5: TUSプロトコルによるZIPアップロード中: ${zipPath}`);
  const meta = `session_id ${btoa(sid)},project_name ${btoa(projectName)},version ${btoa(version)}`;
  const postResponse = await fetch(`${CONFIG.GWC_API}/upload/tus-stream`, {
    method: "POST",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": zipData.length.toString(),
      "Upload-Metadata": meta,
      Authorization: `Bearer ${token}`,
    },
  });
  const location = postResponse.headers.get("Location");
  if (!location)
    throw new Error("TUS Locationヘッダーが取得できませんでした。");
  const patchUrl = location.startsWith("http")
    ? location
    : `${CONFIG.GWC_API}${location}`;
  await fetch(patchUrl, {
    method: "PATCH",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Content-Type": "application/offset+octet-stream",
      "Upload-Offset": "0",
    },
    body: zipData,
  });
  const endClientUpload = performance.now();

  // --- Phase 3: Deploy & Fetch ---
  const startDeploy = performance.now();
  log("Step 6: オンチェーン検証の状態を監視中...");
  let endFetch = 0;
  let fetchDuration = 0;
  for (let i = 0; i < 60; i++) {
    const queryResult = await runCmd([
      CONFIG.BIN.GWC,
      "q",
      "gateway",
      "session",
      sid,
      "--node",
      CONFIG.GWC_RPC,
      "-o",
      "json",
    ]);
    const resultData = JSON.parse(queryResult) as {
      session: { state: string };
    };
    const state = resultData.session.state;
    console.log(state);
    if (state === "SESSION_STATE_CLOSED_SUCCESS") {
      log("Step 7: Webページとしての読み込み速度を計測中...");
      const renderUrl = `${CONFIG.GWC_API}/render/${projectName}/${version}/${firstFilePath}`;
      const startFetchTime = performance.now();
      const MAX_RETRIES = 5;
      for (let r = 1; r <= MAX_RETRIES; r++) {
        try {
          const response = await fetch(renderUrl);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await response.arrayBuffer();
          break;
        } catch (error) {
          if (r === MAX_RETRIES) throw error;
          await new Promise((res) => setTimeout(res, 1000));
        }
      }
      endFetch = performance.now();
      fetchDuration = endFetch - startFetchTime;
      break;
    }
    if (state === "SESSION_STATE_CLOSED_FAILED")
      throw new Error("オンチェーンでの検証に失敗しました。");
    await new Promise((res) => setTimeout(res, 3000));
    if (i === 59) throw new Error("検証がタイムアウトしました。");
  }

  return {
    sid,
    metrics: {
      prepTimeMs: Math.round(endPrep - startPrep),
      clientUploadTimeMs: Math.round(endClientUpload - startClientUpload),
      deployTimeMs: Math.round(endFetch - startDeploy),
      fetchTimeMs: Math.round(fetchDuration),
    },
  };
}
