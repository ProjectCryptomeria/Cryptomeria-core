/**
 * lib/merkle.ts
 */
import { crypto } from "@std/crypto";
import { ensureArrayBuffer } from "./common.ts";

async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", ensureArrayBuffer(bytes));
  return new Uint8Array(hash);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function calculateMerkleRoot(leaves: Uint8Array[]): Promise<Uint8Array> {
  if (leaves.length === 0) return new Uint8Array(32);
  let currentLevel = [...leaves];
  while (currentLevel.length > 1) {
    if (currentLevel.length % 2 !== 0) {
      currentLevel.push(currentLevel[currentLevel.length - 1]);
    }
    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      // 16進数文字列として連結してからバイト列化してハッシュ計算 (merkle_logic.goに準拠)
      const left = toHex(currentLevel[i]);
      const right = toHex(currentLevel[i + 1]);
      nextLevel.push(await sha256(left + right));
    }
    currentLevel = nextLevel;
  }
  return currentLevel[0];
}

export async function buildProjectMerkleRoot(files: { path: string, data: Uint8Array }[], fragSize: number): Promise<string> {
  const fileLeaves: { path: string, hash: Uint8Array }[] = [];

  for (const file of files) {
    const frags: Uint8Array[] = [];
    for (let i = 0; i < file.data.length; i += fragSize) {
      frags.push(file.data.subarray(i, Math.min(i + fragSize, file.data.length)));
    }
    if (frags.length === 0) frags.push(new Uint8Array(0));

    const fragHashes = await Promise.all(frags.map(async (b, i) => {
      const bHashHex = toHex(await sha256(b));
      // HashFragmentLeaf Scheme: SHA256("FRAG:{path}:{index}:{hex(SHA256(fragment))}")
      return await sha256(`FRAG:${file.path}:${i}:${bHashHex}`);
    }));

    const fRoot = await calculateMerkleRoot(fragHashes);
    // HashFileLeaf Scheme: SHA256("FILE:{path}:{size}:{hex(file_root)}")
    const fLeafHash = await sha256(`FILE:${file.path}:${file.data.length}:${toHex(fRoot)}`);
    fileLeaves.push({ path: file.path, hash: fLeafHash });
  }

  // ファイル名で辞書順ソート
  fileLeaves.sort((a, b) => a.path.localeCompare(b.path));
  const finalRoot = await calculateMerkleRoot(fileLeaves.map(f => f.hash));
  return toHex(finalRoot);
}