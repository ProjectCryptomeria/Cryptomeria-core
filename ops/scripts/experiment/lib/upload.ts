/**
 * lib/upload.ts
 * 実験のフェーズごとの実行時間（準備、アップロード、デプロイ、フェッチ）を計測するように拡張
 */
import { runCmd, log } from "./common.ts";
import { CONFIG } from "./config.ts";
import { buildProjectMerkleRoot } from "./merkle.ts";
import { crypto } from "@std/crypto";
import { walk } from "@std/fs/walk";
import { relative, resolve } from "@std/path";

/**
 * 実験で収集するメトリクスの定義
 */
export interface UploadMetrics {
  prepTimeMs: number;          // 準備時間: マークル計算、セッション初期化、Authz、RootProofコミットまで
  clientUploadTimeMs: number;  // クライアントアップロード時間: TUS通信にかかった純粋な時間
  deployTimeMs: number;        // デプロイ時間: TUS終了からWebページが読み込み可能になるまで
  fetchTimeMs: number;         // フェッチ時間: fetch開始から全データ受信完了までの時間
}

/**
 * Cosmos SDKのトランザクションを実行し、成功を待機する内部関数
 */
async function executeTx(args: string[], from: string): Promise<any> {
  const out = await runCmd([
    CONFIG.BIN.GWC, "tx", ...args,
    "--from", from, "--node", CONFIG.GWC_RPC, "--chain-id", CONFIG.CHAIN_ID,
    "--keyring-backend", "test", "--gas", "auto", "--gas-adjustment", "1.5", "-y", "-o", "json"
  ]);
  const res = JSON.parse(out);
  // ブロック生成を待機
  await new Promise(r => setTimeout(r, 6500));
  const q = await runCmd([CONFIG.BIN.GWC, "q", "tx", res.txhash, "--node", CONFIG.GWC_RPC, "-o", "json"]);
  const qRes = JSON.parse(q);
  if (qRes.code !== 0) throw new Error(`TX failed: ${qRes.raw_log}`);
  return qRes;
}

/**
 * GWCに対してCSUプロトコルを用いたアップロードを行い、詳細なメトリクスを計測します
 */
export async function uploadToGwcCsu(
  sourceDir: string,
  zipPath: string,
  fragSize: number,
  projectName: string,
  version: string
): Promise<{ sid: string, metrics: UploadMetrics }> {

  // --- Phase 1: Preparation (準備時間) ---
  const startPrep = performance.now();
  log(`Step 1: ディレクトリの走査中: "${sourceDir}"...`);
  const files: { path: string, data: Uint8Array }[] = [];
  const absSourceDir = resolve(sourceDir);
  let firstFilePath = "";

  for await (const entry of walk(sourceDir, { includeDirs: false })) {
    const relPath = relative(absSourceDir, resolve(entry.path));
    if (!firstFilePath) firstFilePath = relPath;
    const data = await Deno.readFile(entry.path);
    files.push({ path: relPath, data });
  }

  if (files.length === 0) throw new Error("アップロード対象のファイルが見つかりません。");

  // マークルツリーの構築
  const rootHex = await buildProjectMerkleRoot(files, fragSize);

  log("Step 2: セッションの初期化中...");
  const initRes = await executeTx(["gateway", "init-session", fragSize.toString(), "0"], "alice");
  const event = initRes.events.find((e: any) => e.type === "csu_init_session");
  const sid = event.attributes.find((a: any) => a.key === "session_id").value;
  const exec = event.attributes.find((a: any) => a.key === "executor").value;
  const owner = event.attributes.find((a: any) => a.key === "owner").value;

  log("Step 3: 権限（Authz/Feegrant）の設定中...");
  try {
    await executeTx(["feegrant", "grant", owner, exec], "alice");
  } catch (_e) { /* すでに存在する場合は無視 */ }

  for (const m of ["MsgDistributeBatch", "MsgFinalizeAndCloseSession", "MsgAbortAndCloseSession"]) {
    try {
      await executeTx(["authz", "grant", exec, "generic", "--msg-type", `/gwc.gateway.v1.${m}`], "alice");
    } catch (_e) { /* すでに存在する場合は無視 */ }
  }

  log("Step 4: マークルルートのコミット中...");
  await executeTx(["gateway", "commit-root-proof", sid, rootHex], "alice");

  const zipData = await Deno.readFile(zipPath);
  const tokenRaw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`upload_token:${sid}`));
  const token = Array.from(new Uint8Array(tokenRaw)).map(b => b.toString(16).padStart(2, "0")).join("");
  const endPrep = performance.now();

  // --- Phase 2: Client Upload (クライアントアップロード時間) ---
  const startClientUpload = performance.now();
  log(`Step 5: TUSプロトコルによるZIPアップロード中: ${zipPath}`);
  const meta = `session_id ${btoa(sid)},project_name ${btoa(projectName)},version ${btoa(version)}`;

  // TUS POST (作成)
  const postResponse = await fetch(`${CONFIG.GWC_API}/upload/tus-stream`, {
    method: "POST",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": zipData.length.toString(),
      "Upload-Metadata": meta,
      "Authorization": `Bearer ${token}`
    }
  });

  const location = postResponse.headers.get("Location");
  if (!location) throw new Error("TUS Locationヘッダーが取得できませんでした。");
  const patchUrl = location.startsWith("http") ? location : `${CONFIG.GWC_API}${location}`;

  // TUS PATCH (データ転送)
  await fetch(patchUrl, {
    method: "PATCH",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Content-Type": "application/offset+octet-stream",
      "Upload-Offset": "0"
    },
    body: zipData
  });
  const endClientUpload = performance.now();

  // --- Phase 3: Deploy & Fetch (デプロイ時間 & フェッチ時間) ---
  const startDeploy = performance.now();
  log("Step 6: オンチェーン検証の状態を監視中...");

  let endFetch = 0;
  let fetchDuration = 0;

// fetchDuration と endFetch はスコープ外で定義されていることを想定しています
for (let i = 0; i < 60; i++) {
  // セッション状態の取得
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

  // JSONのパース結果を定義（型安全のためインターフェースを想定）
  const resultData = JSON.parse(queryResult) as {
    session: { state: string };
  };
  const state = resultData.session.state;

  if (state === "SESSION_STATE_CLOSED_SUCCESS") {
    log("Step 7: Webページとしての読み込み速度を計測中...");

    const renderUrl = `${CONFIG.GWC_API}/render/${projectName}/${version}/${firstFilePath}`;
    const startFetch = performance.now();

    // --- fetchのリトライループ開始 ---
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 1000;
    let response: Response | undefined;

    for (let retryCount = 1; retryCount <= MAX_RETRIES; retryCount++) {
      try {
        response = await fetch(renderUrl);

        if (!response.ok) {
          throw new Error(`HTTPエラー: ${response.status} ${response.statusText}`);
        }

        // すべてのデータを読み込むまで待機
        await response.arrayBuffer();
        
        // 成功した場合はリトライループを抜ける
        break;
      } catch (error) {
        if (retryCount === MAX_RETRIES) {
          // 最大リトライ回数に達した場合はエラーをスロー
          throw new Error(
            `Webページの読み込みに失敗しました (${MAX_RETRIES}回試行): ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }

        log(
          `fetchに失敗しました。1秒後にリトライします... (${retryCount}/${MAX_RETRIES})`
        );
        // 1秒待機
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
    // --- fetchのリトライループ終了 ---

    endFetch = performance.now();
    fetchDuration = endFetch - startFetch;
    break;
  }

  if (state === "SESSION_STATE_CLOSED_FAILED") {
    throw new Error("オンチェーンでの検証に失敗しました。");
  }

  // セッション状態確認のインターバル（3秒）
  await new Promise((resolve) => setTimeout(resolve, 3000));

  if (i === 59) {
    throw new Error("検証がタイムアウトしました。");
  }
}

  const endDeploy = endFetch;

  return {
    sid,
    metrics: {
      prepTimeMs: Math.round(endPrep - startPrep),
      clientUploadTimeMs: Math.round(endClientUpload - startClientUpload),
      deployTimeMs: Math.round(endDeploy - startDeploy),
      fetchTimeMs: Math.round(fetchDuration),
    }
  };
}