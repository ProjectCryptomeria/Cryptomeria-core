/**
 * lib/merkle.ts
 * サーバー側 (x/gateway/types/merkle_gen.go) の実装に適合させた Merkle Tree 計算ロジック
 */
import { crypto } from "@std/crypto";
import { ensureArrayBuffer, log } from "./common.ts";

/**
 * 文字列またはバイト列のSHA-256ハッシュを計算し、Uint8Arrayで返します。
 */
async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", ensureArrayBuffer(bytes));
  return new Uint8Array(hash);
}

/**
 * バイト列を小文字のHex文字列に変換します。
 */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * サーバー側の hashPair (merkle_gen.go) に適合する MerkleRoot 計算
 * 入力: Hex文字列のリスト
 * 親ノード計算: hex(SHA256(left_hex + right_hex))
 */
export async function calculateMerkleRoot(hexLeaves: string[]): Promise<string> {
  if (hexLeaves.length === 0) {
    // サーバー側の NewMerkleTree/Root は空の場合空文字列を返す挙動
    return "";
  }

  let currentLevel = [...hexLeaves];

  while (currentLevel.length > 1) {
    // 奇数なら末尾複製 (merkle_gen.go: right = left)
    if (currentLevel.length % 2 !== 0) {
      currentLevel.push(currentLevel[currentLevel.length - 1]);
    }

    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const leftHex = currentLevel[i];
      const rightHex = currentLevel[i + 1];

      // 文字列として連結してからハッシュ化 (hex(SHA256(left_hex + right_hex)))
      const rawHash = await sha256(leftHex + rightHex);
      nextLevel.push(toHex(rawHash));
    }
    currentLevel = nextLevel;
  }

  return currentLevel[0];
}

/**
 * ファイルパスの正規化 (zip_logic.go に適合)
 */
export function normalizePath(originalPath: string): string {
  // バックスラッシュの置換
  let p = originalPath.replace(/\\/g, "/");

  // サーバー側の path.Clean / TrimPrefix に合わせる
  p = p.replace(/\/+/g, "/");

  while (p.startsWith("./") || p.startsWith("/")) {
    if (p.startsWith("./")) p = p.slice(2);
    if (p.startsWith("/")) p = p.slice(1);
  }

  return p;
}

/**
 * プロジェクト全体の RootProof を生成 (merkle_gen.go の BuildCSUProofs に適合)
 */
export async function buildProjectMerkleRoot(
  files: { path: string, data: Uint8Array }[],
  fragSize: number
): Promise<string> {
  log(`[Merkle/Sync] Starting build. Files: ${files.length}, FragSize: ${fragSize}`);

  const fileLeaves: { path: string, hexHash: string }[] = [];

  for (const file of files) {
    const normPath = normalizePath(file.path);

    // 1. サーバー側と同様に、空ファイル（サイズ0）はスキップする
    if (file.data.length === 0) {
      log(`[Merkle/Sync] Skipping empty file: ${normPath}`);
      continue;
    }

    // 2. 断片化
    const frags: Uint8Array[] = [];
    for (let i = 0; i < file.data.length; i += fragSize) {
      frags.push(file.data.subarray(i, Math.min(i + fragSize, file.data.length)));
    }

    // 3. Leaf Frag 計算
    // Scheme: FRAG:{path}:{index}:{hex(SHA256(fragment_bytes))}
    const fragHexes: string[] = [];
    for (let i = 0; i < frags.length; i++) {
      const fragDataHash = toHex(await sha256(frags[i]));
      const rawString = `FRAG:${normPath}:${i}:${fragDataHash}`;
      const leafHash = await sha256(rawString);
      fragHexes.push(toHex(leafHash));
    }

    // 4. File Root 計算 (Fragment Tree)
    const fileRootHex = await calculateMerkleRoot(fragHexes);

    // 5. Leaf File 計算
    // Scheme: FILE:{path}:{file_size}:{file_root}
    const rawFileString = `FILE:${normPath}:${file.data.length}:${fileRootHex}`;
    const fileLeafHash = await sha256(rawFileString);
    const fileLeafHex = toHex(fileLeafHash);

    fileLeaves.push({ path: normPath, hexHash: fileLeafHex });
  }

  // 6. 決定論的順序: path 昇順
  fileLeaves.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // 7. RootProof 計算 (Root Tree)
  const rootProofHex = await calculateMerkleRoot(fileLeaves.map(f => f.hexHash));

  log(`[Merkle/Sync] Final RootProof: ${rootProofHex}`);
  return rootProofHex;
}