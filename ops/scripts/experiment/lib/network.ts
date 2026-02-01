/**
 * lib/network.ts
 * Kubernetesポートフォワーディングの管理
 */
import { log } from "./common.ts";
import { CONFIG } from "./config.ts";

export class PortForwarder {
  private processes: Deno.ChildProcess[] = [];

  /**
   * 設定に基づいて全てのポートフォワードを開始
   */
  async start() {
    log("🔌 Starting port-forward for Cryptomeria chains...");
    
    const forwards = [
      // GWC (3000x系)
      { name: "gwc", resource: "pod/cryptomeria-gwc-0", ports: "30003:1317" },
      { name: "gwc-rpc", resource: "pod/cryptomeria-gwc-0", ports: "30007:26657" },
      { name: "gwc-grpc", resource: "pod/cryptomeria-gwc-0", ports: "30000:9090" },
      
      // MDSC (3001x系)
      { name: "mdsc", resource: "pod/cryptomeria-mdsc-0", ports: "30013:1317" },
      { name: "mdsc-rpc", resource: "pod/cryptomeria-mdsc-0", ports: "30017:26657" },
      
      // FDSC (3002x系)
      { name: "fdsc", resource: "pod/cryptomeria-fdsc-0", ports: "30023:1317" },
      { name: "fdsc-rpc", resource: "pod/cryptomeria-fdsc-0", ports: "30027:26657" },

      // Faucet
      { name: "faucet", resource: "svc/faucet", ports: "30045:4500" },
    ];

    for (const f of forwards) {
      const command = new Deno.Command("kubectl", {
        args: [
          "port-forward",
          "-n", CONFIG.NAMESPACE,
          f.resource,
          f.ports,
        ],
        stdout: "null", // ログが煩雑にならないよう捨てる
        stderr: "piped",
      });

      const process = command.spawn();
      this.processes.push(process);
      log(`  → Forwarding ${f.name}: ${f.ports}`);
    }

    // 少し待機してコネクションが確立されるのを待つ
    await new Promise(resolve => setTimeout(resolve, 2000));
    log("✅ All port-forward processes spawned.");
  }

  /**
   * 全てのポートフォワードプロセスを停止
   */
  async stop() {
    log("🛑 Stopping port-forwarding processes...");
    for (const p of this.processes) {
      try {
        p.kill("SIGTERM");
        await p.status;
      } catch { /* ignore */ }
    }
    this.processes = [];
    log("✅ Port-forward stopped.");
  }
}

// シングルトンとしてエクスポート
export const networkManager = new PortForwarder();