/**
 * User-global MCP config store + host-side OAuth flow — local port of the
 * retired node-sdk `legacy/global-mcp-config.ts` / `legacy/mcp-host.ts`
 * (G-1 vscode localization). The engine owns the session-scoped MCP
 * runtime; this store keeps `<KIMI_CODE_HOME>/mcp.json` editable.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import type { McpServerConfig } from "./types";

/** Resolve the Kimi home dir (node-sdk `resolveKimiHome` parity). */
export function resolveKimiHome(homeDir?: string): string {
  if (homeDir !== undefined && homeDir.length > 0) return homeDir;
  const override = process.env["KIMI_CODE_HOME"];
  if (override !== undefined && override.length > 0) return override;
  const base =
    process.env[process.platform === "win32" ? "USERPROFILE" : "HOME"] ??
    (process.platform === "win32" ? process.env["HOME"] : undefined);
  return base === undefined ? "" : join(base, ".kimi-code");
}

interface McpConfigFile {
  raw: Record<string, unknown>;
  rawServers: Record<string, unknown>;
}

/** User-global MCP server config store (`<KIMI_CODE_HOME>/mcp.json`). */
export class GlobalMcpConfigStore {
  readonly path: string;

  constructor(homeDir?: string) {
    this.path = join(resolveKimiHome(homeDir), "mcp.json");
  }

  async list(): Promise<McpServerConfig[]> {
    return Object.entries((await this.read()).rawServers).map(([name, value]) =>
      parseServer(name, value),
    );
  }

  async add(server: McpServerConfig): Promise<McpServerConfig[]> {
    const normalized = parseServerInput(server);
    const file = await this.read();
    if (Object.hasOwn(file.rawServers, normalized.name)) {
      throw new Error(`MCP server "${normalized.name}" already exists`);
    }
    await this.write(file, {
      ...file.rawServers,
      [normalized.name]: persistedEntry(normalized),
    });
    return this.list();
  }

  async update(server: McpServerConfig): Promise<McpServerConfig[]> {
    const normalized = parseServerInput(server);
    const file = await this.read();
    if (!Object.hasOwn(file.rawServers, normalized.name)) {
      throw new Error(`MCP server "${normalized.name}" was not found`);
    }
    await this.write(file, {
      ...file.rawServers,
      [normalized.name]: persistedEntry(normalized),
    });
    return this.list();
  }

  async remove(name: string): Promise<McpServerConfig[]> {
    const normalized = normalizeServerName(name);
    const file = await this.read();
    if (!Object.hasOwn(file.rawServers, normalized)) return this.list();
    const nextServers = Object.fromEntries(
      Object.entries(file.rawServers).filter(([entryName]) => entryName !== normalized),
    );
    await this.write(file, nextServers);
    return this.list();
  }

  async get(name: string): Promise<McpServerConfig> {
    const normalized = normalizeServerName(name);
    const servers = await this.list();
    const server = servers.find((entry) => entry.name === normalized);
    if (server === undefined) throw new Error(`MCP server "${normalized}" was not found`);
    return server;
  }

  private async read(): Promise<McpConfigFile> {
    let text: string;
    try {
      text = await readFile(this.path, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { raw: {}, rawServers: {} };
      }
      throw new Error(`Failed to read ${this.path}: ${describeError(error)}`, { cause: error });
    }
    if (text.trim().length === 0) return { raw: {}, rawServers: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`Invalid JSON in ${this.path}: ${describeError(error)}`, { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid MCP config in ${this.path}: expected a JSON object`);
    }
    const raw = parsed as Record<string, unknown>;
    const rawServersValue = raw["mcpServers"];
    if (rawServersValue !== undefined && (typeof rawServersValue !== "object" || rawServersValue === null)) {
      throw new Error(`Invalid MCP config in ${this.path}: "mcpServers" must be an object`);
    }
    return { raw, rawServers: (rawServersValue ?? {}) as Record<string, unknown> };
  }

  private async write(
    file: McpConfigFile,
    rawServers: Record<string, unknown>,
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, `${JSON.stringify({ ...file.raw, mcpServers: rawServers }, null, 2)}\n`);
  }
}

/** Parse one `mcpServers.<name>` value, inferring the transport. */
function parseServer(name: string, value: unknown): McpServerConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid MCP server "${name}" in global config: expected an object`);
  }
  const obj = { ...(value as Record<string, unknown>) };
  if (typeof obj["transport"] !== "string") {
    if (typeof obj["command"] === "string") obj["transport"] = "stdio";
    else if (typeof obj["url"] === "string") obj["transport"] = "http";
  }
  if (obj["transport"] !== "stdio" && obj["transport"] !== "http" && obj["transport"] !== "sse") {
    throw new Error(`Invalid MCP server "${name}" in global config: unknown transport`);
  }
  return { name, ...obj } as McpServerConfig;
}

function parseServerInput(server: McpServerConfig): McpServerConfig {
  const name = normalizeServerName(server.name);
  if (server.transport === "stdio" && (server.command === undefined || server.command.length === 0)) {
    throw new Error(`MCP server "${name}" requires a command`);
  }
  if (
    (server.transport === "http" || server.transport === "sse") &&
    (server.url === undefined || server.url.length === 0)
  ) {
    throw new Error(`MCP server "${name}" requires a URL`);
  }
  return { ...server, name };
}

function persistedEntry(server: McpServerConfig): Record<string, unknown> {
  const { name: _name, ...entry } = server;
  return entry;
}

function normalizeServerName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0) throw new Error("MCP server name cannot be empty");
  return normalized;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Host-side OAuth flow facade ────────────────────────────────────────────

const activeFlows = new Map<string, { name: string; url: string }>();

/** Begin the OAuth flow for a remote server (host owns the token store). */
export function beginGlobalMcpServerAuth(
  server: McpServerConfig,
): { status: string; flowId: string; authorizationUrl: string } {
  if (server.transport !== "http" && server.transport !== "sse") {
    throw new Error(`MCP server "${server.name}" does not use a remote transport`);
  }
  if (server.url === undefined || server.url.length === 0) {
    throw new Error(`MCP server "${server.name}" has no URL`);
  }
  const flowId = randomUUID();
  const separator = server.url.includes("?") ? "&" : "?";
  const authorizationUrl = `${server.url}${separator}oauth=begin`;
  activeFlows.set(flowId, { name: server.name, url: authorizationUrl });
  return { status: "authorization-required", flowId, authorizationUrl };
}

/** Complete a flow (the browser flow finished); errors on an unknown id. */
export function completeGlobalMcpServerAuth(flowId: string): void {
  if (!activeFlows.delete(flowId)) {
    throw new Error(`Unknown MCP OAuth flow: ${flowId}`);
  }
}

/** Cancel a flow (idempotent). */
export function cancelGlobalMcpServerAuth(flowId: string): void {
  activeFlows.delete(flowId);
}

/** Validate the server is remote (the host owns clearing credentials). */
export function resetGlobalMcpServerAuth(server: McpServerConfig): void {
  if (server.transport !== "http" && server.transport !== "sse") {
    throw new Error(`MCP server "${server.name}" does not use a remote transport`);
  }
}
