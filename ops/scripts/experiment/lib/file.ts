/**
 * lib/file.ts
 */
import { runCmd } from "./common.ts";
import { resolve } from "@std/path";

export async function createDummyFile(path: string, size: number) {
  const data = new Uint8Array(size);
  const LIMIT = 65536;
  for (let i = 0; i < size; i += LIMIT) {
    crypto.getRandomValues(data.subarray(i, Math.min(i + LIMIT, size)) as Uint8Array<ArrayBuffer>);
  }
  await Deno.writeFile(path, data);
}

/**
 * ディレクトリ内部に移動してから圧縮を実行し、ZIP内のパスをクリーンにする
 */
export async function createZip(dir: string, zipPath: string) {
  // ZIPファイルの出力先を絶対パスに解決
  const absoluteZipPath = resolve(Deno.cwd(), zipPath);
  // ディレクトリへ移動して、中身を圧縮
  await runCmd(["zip", "-r", absoluteZipPath, "."], { cwd: dir });
}