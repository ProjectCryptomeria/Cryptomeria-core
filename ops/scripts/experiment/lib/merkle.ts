import { crypto } from "@std/crypto";

/**
 * システム形式のマークルツリー生成
 * 詳細は apps/gwc/x/gateway/keeper/merkle_logic.go に準拠
 */
export async function generateRootProof(fragments: Uint8Array<ArrayBuffer>[]): Promise<string> {
  const hashes = await Promise.all(
    fragments.map(async (f) => {
      // BufferSourceへの変換時の型不整合を解消するためにArrayBufferにキャスト
      const digest = await crypto.subtle.digest("SHA-256", f);
      return new Uint8Array(digest);
    })
  );

  // 簡易実装: ハッシュのペアを結合して親ハッシュを作る (実際のロジックに合わせて調整が必要)
  let currentLayer = hashes;
  while (currentLayer.length > 1) {
    const nextLayer = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      if (i + 1 < currentLayer.length) {
        const combined = new Uint8Array([...currentLayer[i], ...currentLayer[i+1]]);
        nextLayer.push(new Uint8Array(await crypto.subtle.digest("SHA-256", combined)));
      } else {
        nextLayer.push(currentLayer[i]);
      }
    }
    currentLayer = nextLayer;
  }
  return btoa(String.fromCharCode(...currentLayer[0]));
}