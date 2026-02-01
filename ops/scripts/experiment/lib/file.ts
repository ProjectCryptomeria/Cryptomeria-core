/**
 * lib/file.ts
 * テストファイル生成とZIP処理
 */
import { runCmd } from "./common.ts";

/**
 * 指定されたサイズのテスト用ダミーファイルを生成する
 * (crypto.getRandomValues の 64KB 制限を考慮して分割生成)
 */
export async function createDummyFile(path: string, sizeInBytes: number) {
  const data = new Uint8Array(sizeInBytes);
  const QUOTA_LIMIT = 65536; // 64KB の制限
  
  // 制限を超えないように分割して乱数を注入
  for (let i = 0; i < sizeInBytes; i += QUOTA_LIMIT) {
    const end = Math.min(i + QUOTA_LIMIT, sizeInBytes);
    const chunk = data.subarray(i, end);
    // 型キャストを行い、制限内のチャンクに対して乱数を生成
    crypto.getRandomValues(chunk as Uint8Array<ArrayBuffer>);
  }
  
  await Deno.writeFile(path, data);
}

/**
 * 指定されたディレクトリをZIPに固める
 */
export async function createZip(dirPath: string, zipName: string) {
  // Deno.CommandでOS標準のzipコマンドを実行
  await runCmd(["zip", "-r", zipName, dirPath]);
}

/**
 * ZIPファイルを解凍する
 */
export async function extractZip(zipPath: string, destPath: string) {
  await Deno.mkdir(destPath, { recursive: true });
  await runCmd(["unzip", "-o", zipPath, "-d", destPath]);
}