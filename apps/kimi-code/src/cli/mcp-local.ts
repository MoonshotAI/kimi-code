/**
 * Local MCP server config surface for the session engine — replaces the
 * node-sdk `loadMcpServers` / `McpServerConfig` wrapper (G-1 consumption
 * switch). Only the user-global `mcp.json` is read: the session engine always
 * runs with `trustProjectMcpConfig: false` (a headless run never auto-starts
 * untrusted project stdio), so the project-root files the SDK merged are dead
 * weight here. Parsing is deliberately lenient — a malformed entry degrades to
 * its raw shape instead of failing the whole file, and the caller's
 * fault-isolation catches anything that does throw.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveKimiHome } from '#/cli/runtime-config';

/** One MCP server declaration from `mcp.json` (lenient local shape). */
export interface McpServerConfigEntry {
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  bearerTokenEnvVar?: string;
  enabled?: boolean;
  enabledTools?: string[];
  disabledTools?: string[];
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  [key: string]: unknown;
}

interface McpJsonFile {
  mcpServers?: Record<string, unknown>;
}

/**
 * Load MCP server declarations from the user-global `~/.kimi-code/mcp.json`.
 * Mirrors the SDK's `loadMcpServers({ trustProjectMcpConfig: false })`:
 * entries without an explicit `transport` are inferred from their shape
 * (`command` → stdio, `url` → http), missing/empty files yield `{}`.
 */
export async function loadUserMcpServers(
  homeDir?: string,
): Promise<Record<string, McpServerConfigEntry>> {
  const filePath = join(resolveKimiHome(homeDir), 'mcp.json');
  let text: string;
  try {
    text = await readFile(filePath, 'utf-8');
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
  if (text.trim().length === 0) return {};

  const parsed: unknown = JSON.parse(text);
  const servers = isRecord(parsed) ? (parsed as McpJsonFile).mcpServers : undefined;
  if (servers === undefined) return {};

  const out: Record<string, McpServerConfigEntry> = {};
  for (const [name, value] of Object.entries(servers)) {
    if (!isRecord(value)) continue;
    const entry = value as McpServerConfigEntry;
    out[name] = entry.transport !== undefined ? entry : inferTransport(entry);
  }
  return out;
}

function inferTransport(entry: McpServerConfigEntry): McpServerConfigEntry {
  const hasCommand = typeof entry.command === 'string';
  const hasUrl = typeof entry.url === 'string';
  if (hasCommand && !hasUrl) return { ...entry, transport: 'stdio' };
  if (hasUrl && !hasCommand) return { ...entry, transport: 'http' };
  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code: unknown }).code === 'ENOENT' || (error as { code: unknown }).code === 'ENOTDIR')
  );
}
