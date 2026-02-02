/**
 * lib/merkle.ts
 * サーバー側 (Go) の実装に完全に適合させた修正版
 */
import { crypto } from "@std/crypto";
import { ensureArrayBuffer, log } from "./common.ts";

/**
 * SHA-256ハッシュを計算し、hex文字列で返します。
 */
async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", ensureArrayBuffer(bytes));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * サーバー側の NewMerkleTree (merkle_gen.go) に適合する Merkle Root 計算
 */
export async function calculateMerkleRoot(hexLeaves: string[]): Promise<string> {
  if (hexLeaves.length === 0) return "";
  if (hexLeaves.length === 1) return hexLeaves[0];

  let currentLevel = [...hexLeaves];

  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      // 奇数の場合は末尾複製 (Go: right = left)
      const right = (i + 1 < currentLevel.length) ? currentLevel[i + 1] : left;

      // サーバー側 hashPair: hex(SHA256(left_hex + right_hex))
      const combinedHash = await sha256Hex(left + right);
      nextLevel.push(combinedHash);
    }
    currentLevel = nextLevel;
  }

  return currentLevel[0];
}

/**
 * Go の path.Clean(p) および TrimPrefix の挙動を再現
 */
export function normalizePath(originalPath: string): string {
  // 1. \ を / に置換
  let p = originalPath.replace(/\\/g, "/");

  // 2. 重複するスラッシュを削除
  p = p.replace(/\/+/g, "/");

  // 3. 先頭の ./ と / を削除 (Go の zip_logic.go: TrimPrefix 相当)
  while (p.startsWith("./") || p.startsWith("/")) {
    if (p.startsWith("./")) p = p.slice(2);
    else if (p.startsWith("/")) p = p.slice(1);
  }

  // 4. 末尾のスラッシュを削除
  if (p.endsWith("/") && p.length > 1) p = p.slice(0, -1);

  return p;
}

/**
 * サーバー側 BuildCSUProofs (merkle_gen.go) に完全に準拠した RootProof 生成
 */
export async function buildProjectMerkleRoot(
  files: { path: string, data: Uint8Array }[],
  fragSize: number
): Promise<string> {
  log(`[Merkle/Sync] Building for ${files.length} files. FragSize: ${fragSize}`);

  // 1. 各ファイルの情報を整理し、正規化パスで管理
  const processedFiles: { normPath: string, data: Uint8Array }[] = [];
  for (const f of files) {
    const normPath = normalizePath(f.path);
    // サーバー側 (merkle_gen.go): 空ファイルはスキップ
    if (f.data.length === 0) {
      log(`[Merkle/Sync] Skipping empty file: ${normPath}`);
      continue;
    }
    processedFiles.push({ normPath, data: f.data });
  }

  // 2. パスで昇順ソート (Go: sort.Slice(files, ...))
  processedFiles.sort((a, b) => (a.normPath < b.normPath ? -1 : a.normPath > b.normPath ? 1 : 0));

  const fileLeaves: string[] = [];

  for (const f of processedFiles) {
    // 3. 断片化
    const fragHexes: string[] = [];
    const numFrags = Math.ceil(f.data.length / fragSize);

    for (let i = 0; i < numFrags; i++) {
      const start = i * fragSize;
      const end = Math.min(start + fragSize, f.data.length);
      const chunk = f.data.subarray(start, end);

      // frag_digest_hex = hex(SHA256(fragment_bytes))
      const chunkHash = await sha256Hex(chunk);
      // leaf_frag = SHA256("FRAG:{path}:{index}:{frag_digest_hex}")
      const leafFrag = await sha256Hex(`FRAG:${f.normPath}:${i}:${chunkHash}`);
      fragHexes.push(leafFrag);
    }

    // 4. File Root 計算 (Fragment Tree)
    const fileRoot = await calculateMerkleRoot(fragHexes);

    // 5. File Leaf 計算
    // leaf_file = SHA256("FILE:{path}:{file_size}:{file_root}")
    const leafFile = await sha256Hex(`FILE:${f.normPath}:${f.data.length}:${fileRoot}`);

    log(`[Merkle/Sync] File: ${f.normPath} (Size: ${f.data.length}) Root: ${fileRoot}`);
    fileLeaves.push(leafFile);
  }

  // 6. RootProof 計算 (Root Tree)
  const rootProof = await calculateMerkleRoot(fileLeaves);
  log(`[Merkle/Sync] Result RootProof: ${rootProof}`);

  return rootProof;
}