/**
 * lib/common.ts
 */
export async function runCmd(args: string[], options?: { env?: Record<string, string>, cwd?: string }) {
  const command = new Deno.Command(args[0], {
    args: args.slice(1),
    env: options?.env,
    cwd: options?.cwd, // 実行ディレクトリを指定可能にする
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

export async function saveResult(name: string, data: any) {
  const path = `./results/${name}.json`;
  await Deno.mkdir("./results", { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2));
  log(`Results saved to ${path}`);
}

export function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer;
}

export function ensureArrayBuffer(data: Uint8Array): ArrayBuffer {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength && isArrayBuffer(data.buffer)) {
    return data.buffer;
  }
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

export function toError(error: unknown): Error {
  if (error instanceof Error) return error;

  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}