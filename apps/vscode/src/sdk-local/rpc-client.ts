/**
 * Local engine RPC client — spawns `kimi-server-serve` (the Rust server
 * binary) and speaks the stdio JSON-RPC protocol directly, replacing the
 * node-sdk `createKimiHarness` runtime (G-1 vscode localization).
 *
 * Protocol (same as `kimi-sdk`'s Remote harness): requests on stdin as
 * `{"jsonrpc":"2.0","id":N,"method":...,"params":...}`, responses on stdout
 * matched by id, engine events on stderr as `[event] {json}` lines.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { KimiError } from "./errors";

/** Engine RPC method names (kimi-protocol `methods.rs` constants, local). */
export const METHODS = {
  SESSION_CREATE: "session/create",
  SESSION_LOAD: "session/load",
  SESSION_PROMPT: "session/prompt",
  SESSION_CANCEL: "session/cancel",
  SESSION_COMPACT: "session/compact",
  SESSION_CANCEL_COMPACT: "session/cancel_compact",
  SESSION_STEER: "session/steer",
  SESSION_UPDATE_METADATA: "session/update_metadata",
  SESSION_GET_STATUS: "session/get_status",
  SESSION_GET_CONTEXT: "session/get_context",
  SESSION_LIST: "session/list",
  SESSION_SAVE: "session/save",
  SESSION_FORK: "session/fork",
  SESSION_DELETE: "session/delete",
  SESSION_SET_THINKING: "session/set_thinking",
  SESSION_SET_MODEL: "session/set_model",
  SESSION_SET_PLAN_MODE: "session/set_plan_mode",
  SESSION_ACTIVATE_SKILL: "session/activate_skill",
  SESSION_INIT: "session/init",
  SESSION_CLEAR_CONTEXT: "session/clear_context",
  SESSION_GET_PLAN: "session/get_plan",
  SESSION_CLEAR_PLAN: "session/clear_plan",
  SESSION_IMPORT_CONTEXT: "session/import_context",
  SESSION_ADD_DIR: "session/add_additional_dir",
  SESSION_APPROVAL_RESOLVE: "session/approval_resolve",
  PERMISSION_SET_MODE: "permission/set_mode",
  CONFIG_GET: "config/get",
  CONFIG_SET: "config/set",
} as const;

/** Locate the `kimi-server-serve` binary (env → target/ → packaged bin → PATH). */
export function findServerBinary(): string {
  const env = process.env["KIMI_SERVER_BIN"];
  if (env !== undefined && env.length > 0) return env;
  const exe = process.platform === "win32" ? ".exe" : "";
  // Dev checkout: the workspace `target/` build (release preferred, then debug).
  for (const profile of ["release", "debug"]) {
    const built = join(
      __dirname,
      "..",
      "..",
      "..",
      "..",
      "target",
      profile,
      `kimi-server-serve${exe}`,
    );
    if (existsSync(built)) return built;
  }
  // Packaged next to the CLI binaries (kimi-code-rust-bin `bin/`).
  const packaged = join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "packages",
    "kimi-code-rust-bin",
    "bin",
    `kimi-server-serve-${process.platform}-${process.arch}${exe}`,
  );
  if (existsSync(packaged)) return packaged;
  return "kimi-server-serve";
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type EventListener = (event: Record<string, unknown>) => void;

/** One stdio JSON-RPC connection to the engine server. */
export class EngineRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<EventListener>();
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closed = false;

  constructor(bin = findServerBinary(), env?: Record<string, string>) {
    this.child = spawn(bin, [], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    this.child.on("error", (error) => {
      this.failAll(new KimiError("internal", `Failed to spawn ${bin}: ${error.message}`, error));
    });
    this.child.on("exit", (code) => {
      this.failAll(
        new KimiError(
          "internal",
          `Engine server exited unexpectedly (code ${code ?? "?"})`,
        ),
      );
    });
  }

  /** One JSON-RPC call; resolves with the `result` value. */
  call(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new KimiError("internal", "Engine client is closed."));
    const id = this.nextId++;
    const request = { jsonrpc: "2.0", id, method, params: params ?? null };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new KimiError("internal", `RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  /** Subscribe to engine events (stderr `[event]` lines). */
  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new KimiError("internal", "Engine client closed."));
    }
    this.pending.clear();
    this.listeners.clear();
    this.child.kill();
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      this.dispatchResponse(line);
    }
  }

  private dispatchResponse(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Not ours (diagnostics); ignore.
    }
    if (typeof message["method"] === "string") {
      // Server-initiated request — the engine never issues any on this
      // transport; ignore defensively.
      return;
    }
    const id = message["id"];
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message["error"] !== undefined && message["error"] !== null) {
      const error = message["error"] as Record<string, unknown>;
      pending.reject(
        new KimiError(
          typeof error["code"] === "string" ? (error["code"] as string) : "internal",
          typeof error["message"] === "string" ? (error["message"] as string) : "RPC error",
          error,
        ),
      );
      return;
    }
    pending.resolve(message["result"]);
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBuffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = this.stderrBuffer.indexOf("\n")) >= 0) {
      const line = this.stderrBuffer.slice(0, newline);
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      const prefix = "[event] ";
      if (!line.startsWith(prefix)) continue;
      try {
        const event = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
        for (const listener of this.listeners) {
          listener(event);
        }
      } catch {
        // Malformed event line — skip, never fatal.
      }
    }
  }

  private failAll(error: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }
}
