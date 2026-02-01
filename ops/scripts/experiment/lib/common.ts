/**
 * 共通ユーティリティ: コマンド実行やログ管理
 */
export async function runCmd(args: string[], env?: Record<string, string>) {
    const command = new Deno.Command(args[0], {
        args: args.slice(1),
        env,
        stdout: "piped",
        stderr: "piped",
    });
    const { code, stdout, stderr } = await command.output();
    const output = new TextDecoder().decode(stdout);
    const error = new TextDecoder().decode(stderr);
    if (code !== 0) throw new Error(`Command failed: ${args.join(" ")}\n${error}`);
    return output.trim();
}

export function log(message: string) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

export async function saveResult(name: string, data: unknown) {
    const path = `./results/${name}.json`;
    await Deno.mkdir("./results", { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(data, null, 2));
    log(`Results saved to ${path}`);
}

export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

/**
 * 値が純粋な ArrayBuffer (SharedArrayBufferではない) かどうかを判定する型ガード
 */
export function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer;
}

/**
 * Uint8Array から純粋な ArrayBuffer を確実に取得する。
 * 共有バッファやオフセットがある場合は新しい ArrayBuffer にコピーする。
 */
export function ensureArrayBuffer(data: Uint8Array): ArrayBuffer {
  // すでに純粋な ArrayBuffer であり、全体を指している場合はそのまま返す
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && isArrayBuffer(data.buffer)) {
    return data.buffer;
  }
  // 部分的なビューや SharedArrayBuffer の場合は、必要な範囲だけをコピーして新しい ArrayBuffer を作る
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}