/**
 * lib/file.ts
 */
import { runCmd } from "./common.ts";

export async function createDummyFile(path: string, size: number) {
  const data = new Uint8Array(size);
  const LIMIT = 65536;
  for (let i = 0; i < size; i += LIMIT) {
    crypto.getRandomValues(data.subarray(i, Math.min(i + LIMIT, size)) as Uint8Array<ArrayBuffer>);
  }
  await Deno.writeFile(path, data);
}

export async function createZip(dir: string, zipPath: string) {
  await runCmd(["zip", "-r", zipPath, dir]);
}