import { runCmd } from "./common.ts";

/**
 * テストファイル生成とZIP処理
 */
export async function createDummyFile(path: string, sizeInBytes: number) {
  const data = new Uint8Array(sizeInBytes);
  crypto.getRandomValues(data);
  await Deno.writeFile(path, data);
}

export async function createZip(dirPath: string, zipName: string) {
  // Deno.Commandでzipコマンドを実行
  await runCmd(["zip", "-r", zipName, dirPath]);
}