import * as vscode from "vscode";
import { spawn } from "child_process";

const MIN_CLI_VERSION = "0.14.0";

interface CLIInfo {
  version: string;
}

let instance: CLIManager | null = null;

export function initCLIManager(): CLIManager {
  instance = new CLIManager();
  return instance;
}

export function getCLIManager(): CLIManager {
  if (!instance) {
    throw new Error("CLIManager not initialized");
  }
  return instance;
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `${cmd} exited with ${code}`))));
  });
}

function compareVersions(a: string, b: string): number {
  // Compare only the numeric core, ignoring any -prerelease / +build suffix
  // (e.g. "0.14.0-beta.1" is treated as "0.14.0") so Number() never sees NaN.
  const core = (v: string) => v.split(/[-+]/)[0].split(".").map(Number);
  const pa = core(a);
  const pb = core(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export class CLIManager {
  getExecutablePath(): string {
    return vscode.workspace.getConfiguration("kimi").get<string>("executablePath", "") || "kimi";
  }

  async checkInstalled(): Promise<boolean> {
    const info = await this.getInfo(this.getExecutablePath()).catch(() => null);
    return info !== null && this.meetsRequirements(info);
  }

  async installCLI(): Promise<void> {
    if (await this.checkInstalled()) {
      return;
    }

    const choice = await vscode.window.showErrorMessage(
      `Kimi Code CLI is not installed or is too old. Install the latest Kimi Code CLI, then make sure \`kimi --version\` reports ${MIN_CLI_VERSION} or newer.`,
      "Open Terminal",
    );
    if (choice === "Open Terminal") {
      const terminal = vscode.window.createTerminal("Install Kimi Code");
      terminal.show();
      terminal.sendText("npm install -g @moonshot-ai/kimi-code");
    }
    throw new Error("Kimi Code CLI is not installed");
  }

  private async getInfo(execPath: string): Promise<CLIInfo> {
    const env = vscode.env.remoteName ? ` (remote: ${vscode.env.remoteName})` : "";
    console.log(`[Kimi CLI] Getting version from ${execPath}${env}`);
    const output = await exec(execPath, ["--version"]);
    const version = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? output.trim();
    return { version };
  }

  private meetsRequirements(info: CLIInfo): boolean {
    return compareVersions(info.version, MIN_CLI_VERSION) >= 0;
  }
}
