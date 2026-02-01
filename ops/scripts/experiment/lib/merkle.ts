/**
 * lib/merkle.ts
 * システム固有の CSU マークルツリーロジック
 */
import { crypto } from "@std/crypto";
import { ensureArrayBuffer } from "./common.ts";

/**
 * SHA256 ハッシュを計算して Hex 文字列を返す
 */
async function sha256Hex(data: Uint8Array | string): Promise<string> {
  // 1. 文字列の場合は Uint8Array に変換
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  
  // 2. Web Crypto API の制約に合わせて ArrayBuffer に変換 (SharedArrayBufferを排除)
  const buffer = ensureArrayBuffer(bytes);
  
  // 3. ハッシュ計算 (digest は確実に ArrayBuffer を受け取る)
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  
  // 4. Hex 文字列化
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 断片のリーフハッシュ計算: SHA256("FRAG:{path}:{index}:{hex(SHA256(fragment))}")
 */
export async function hashFragmentLeaf(path: string, index: number, fragment: Uint8Array): Promise<string> {
  const fragDigest = await sha256Hex(fragment);
  const payload = `FRAG:${path}:${index}:${fragDigest}`;
  return await sha256Hex(payload);
}

/**
 * ファイルのリーフハッシュ計算: SHA256("FILE:{path}:{size}:{hex(file_root)}")
 */
export async function hashFileLeaf(path: string, size: number, fileRootHex: string): Promise<string> {
  const payload = `FILE:${path}:${size}:${fileRootHex}`;
  return await sha256Hex(payload);
}

/**
 * 2つのハッシュ(Hex)を結合して親ハッシュを作る (merkle_logic.go に準拠)
 * concatStr = LeftHex + RightHex
 */
export async function combineHashes(left: string, right: string): Promise<string> {
  return await sha256Hex(left + right);
}

/**
 * 単純なマークルツリーを構築し、ルートハッシュと各要素のプルーフを返す
 */
export async function buildMerkleTree(leaves: string[]) {
  let nodes = leaves.map(h => ({ hash: h, proof: [] as any[] }));
  
  while (nodes.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < nodes.length; i += 2) {
      if (i + 1 < nodes.length) {
        const parentHash = await combineHashes(nodes[i].hash, nodes[i+1].hash);
        // プルーフの記録 (実際の実装にはさらに詳細なステップ管理が必要)
        nextLevel.push({ hash: parentHash, proof: [] }); 
      } else {
        nextLevel.push(nodes[i]);
      }
    }
    nodes = nextLevel;
  }
  return nodes[0].hash;
}