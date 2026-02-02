/**
 * lib/file.ts
 */
import JSZip from "npm:jszip@3.10.1";
import { walk } from "@std/fs";
import { relative } from "@std/path";

/**
 * 指定したパスにダミーファイルを作成します。
 *
 */
export async function createDummyFile(path: string, size: number) {
  const data = new Uint8Array(size);
  const LIMIT = 65536;
  for (let i = 0; i < size; i += LIMIT) {
    crypto.getRandomValues(data.subarray(i, Math.min(i + LIMIT, size)) as Uint8Array<ArrayBuffer>);
  }
  await Deno.writeFile(path, data);
}

/**
 * JSZipを使用してディレクトリを圧縮し、ZIPファイルとして保存します。
 * zip.ts のパス正規化ロジックと JSZip 処理を Deno 向けに統合しています。
 *
 */
export async function createZip(dirPath: string, zipOutputPath: string) {
  const zip = new JSZip();

  // 1. ディレクトリ内を走査してファイルリストを取得
  // .git フォルダを除外するロジックを走査時に適用
  for await (
    const entry of walk(dirPath, {
      includeDirs: false,
      skip: [/(\/|\\)\.git(\/|\\)/],
    })
  ) {
    // 2. ZIP内のパスを計算
    // zip.ts の「共通ルート除去」に相当する処理を relative で実現
    const relativePath = relative(dirPath, entry.path).replace(/\\/g, "/");

    // ファイルデータを読み込み
    const fileData = await Deno.readFile(entry.path);

    // 3. ZIPに追加
    zip.file(relativePath, fileData);
  }

  // 4. ZIPバイナリの生成
  // プラットフォームをUNIXに固定し、BlobではなくUint8Arrayとして生成
  const content = await zip.generateAsync({
    type: "uint8array",
    platform: "UNIX",
    compression: "DEFLATE",
    compressionOptions: {
      level: 9,
    },
  });

  // 5. ファイルシステムへ書き出し
  await Deno.writeFile(zipOutputPath, content);
}