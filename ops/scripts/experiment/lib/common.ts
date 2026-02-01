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