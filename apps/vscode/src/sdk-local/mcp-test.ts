/**
 * Host-side MCP stdio probe — local port of the node-sdk
 * `testGlobalMcpServerHost` (G-1 vscode localization). Only stdio is
 * supported; remote transports report a failure (the engine's session
 * runtime connects those).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";

import type { McpServerConfig, McpTestResult } from "./types";

/** Connect a user-global server once and report its discovered tools. */
export async function testGlobalMcpServer(server: McpServerConfig): Promise<McpTestResult> {
  if (server.transport !== "stdio") {
    return {
      success: false,
      output: `MCP server "${server.name}" uses "${server.transport}" transport; only stdio is supported for host-side testing`,
    };
  }
  const command = server.command ?? "";
  if (command.length === 0) {
    return { success: false, output: `MCP server "${server.name}" has no command` };
  }
  // Pre-flight the executable: a missing absolute/relative path spawns and
  // immediately closes, which hides the ENOENT the probe should surface.
  if (command.includes("/") || command.includes("\\")) {
    if (!existsSync(command)) {
      return { success: false, output: `spawn ${command} ENOENT` };
    }
  }
  const client = new McpStdioProbe(command, server.args ?? [], server.env, server.cwd);
  try {
    const tools = await client.probe();
    const lines = [
      `Connected to MCP server "${server.name}".`,
      `Available tools: ${tools.length}`,
      ...tools.map((tool) => `- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`),
    ];
    return { success: true, output: lines.join("\n") };
  } catch (error) {
    return { success: false, output: error instanceof Error ? error.message : String(error) };
  } finally {
    client.close();
  }
}

interface ProbeTool {
  readonly name: string;
  readonly description?: string;
}

/** Minimal MCP stdio client: spawn → initialize → tools/list → shutdown. */
class McpStdioProbe {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = "";

  constructor(
    command: string,
    args: readonly string[],
    env: Record<string, string> | undefined,
    cwd: string | undefined,
  ) {
    this.child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      ...(cwd === undefined ? {} : { cwd }),
    });
  }

  async probe(): Promise<ProbeTool[]> {
    // The probe speaks the legacy initialize handshake (2025-11-25), which
    // both legacy and 2026-07-28 servers accept; stateless servers that
    // reject initialize fall through to a bare tools/list.
    const initialized = await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "kimi-code-vscode", version: "0.0.0-test" },
    }).catch(() => false);
    if (initialized !== false) {
      await this.request("notifications/initialized", {}).catch(() => {});
    }
    const listed = await this.request("tools/list", {});
    const tools = (listed as { tools?: ProbeTool[] } | undefined)?.tools ?? [];
    await this.request("shutdown", {}).catch(() => {});
    return tools;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        let newline: number;
        while ((newline = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, newline).trim();
          this.buffer = this.buffer.slice(newline + 1);
          if (line.length === 0) continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (message["id"] !== id) continue;
          this.child.stdout.off("data", onData);
          if (message["error"] !== undefined && message["error"] !== null) {
            reject(
              new Error(
                `MCP ${method} failed: ${JSON.stringify(message["error"]).slice(0, 200)}`,
              ),
            );
            return;
          }
          resolve(message["result"]);
        }
      };
      this.child.stdout.on("data", onData);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    this.child.kill();
  }
}
