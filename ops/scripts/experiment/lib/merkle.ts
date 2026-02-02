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
    if (currentLevel.length % 2 !== 0) currentLevel.push(currentLevel[currentLevel.length - 1]);
    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      nextLevel.push(await sha256(toHex(currentLevel[i]) + toHex(currentLevel[i + 1])));
    }
    currentLevel = nextLevel;
  }
  return currentLevel[0];
}

export async function buildProjectMerkleRoot(files: { path: string, data: Uint8Array }[], fragSize: number): Promise<string> {
  const fileLeaves: { path: string, hash: Uint8Array }[] = [];
  for (const file of files) {
    const frags = [];
    for (let i = 0; i < file.data.length; i += fragSize) frags.push(file.data.subarray(i, i + fragSize));
    if (frags.length === 0) frags.push(new Uint8Array(0));
    const fragHashes = await Promise.all(frags.map(async (b, i) => await sha256(`FRAG:${file.path}:${i}:${toHex(await sha256(b))}`)));
    const fRoot = await calculateMerkleRoot(fragHashes);
    fileLeaves.push({ path: file.path, hash: await sha256(`FILE:${file.path}:${file.data.length}:${toHex(fRoot)}`) });
  }
  fileLeaves.sort((a, b) => a.path.localeCompare(b.path));
  return toHex(await calculateMerkleRoot(fileLeaves.map(f => f.hash)));
}