/**
 * lib/network.ts
 */
import { log } from "./common.ts";
import { CONFIG } from "./config.ts";

export class PortForwarder {
  private processes: Deno.ChildProcess[] = [];

  async start() {
    log("🔌 Starting port-forward for Cryptomeria...");
    const forwards = [
      { resource: "pod/cryptomeria-gwc-0", ports: "30003:1317" },
      { resource: "pod/cryptomeria-gwc-0", ports: "30007:26657" },
      { resource: "pod/cryptomeria-mdsc-0", ports: "30013:1317" },
      { resource: "pod/cryptomeria-mdsc-0", ports: "30017:26657" },
      { resource: "pod/cryptomeria-fdsc-0", ports: "30023:1317" },
      { resource: "pod/cryptomeria-fdsc-0", ports: "30027:26657" },
      { resource: "svc/faucet", ports: "30045:4500" },
    ];

    for (const f of forwards) {
      const process = new Deno.Command("kubectl", {
        args: ["port-forward", "-n", CONFIG.NAMESPACE, f.resource, f.ports],
        stdout: "null",
        stderr: "null",
      }).spawn();
      this.processes.push(process);
    }
    await new Promise(r => setTimeout(r, 2000));
    log("✅ Port-forward processes started.");
  }

  stop() {
    log("🛑 Stopping port-forward...");
    for (const p of this.processes) {
      try { p.kill("SIGTERM"); } catch { /* ignore */ }
    }
    this.processes = [];
  }
}

export const networkManager = new PortForwarder();