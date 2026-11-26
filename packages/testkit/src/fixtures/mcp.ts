import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FakeMcpCatalog, FakeMcpTool, McpCall } from '#/fixtures/mcp-catalog';

export type { FakeMcpCatalog, FakeMcpReply, FakeMcpText, FakeMcpTool, McpCall } from '#/fixtures/mcp-catalog';

export const FAKE_MCP_SERVER = fileURLToPath(new URL('./mcp-server-process.ts', import.meta.url));

export interface FakeMcpExit {
  readonly code?: number;
  readonly stderr?: string;
}

export interface FakeMcpProcessTool extends FakeMcpTool {
  readonly exitAfterReply?: FakeMcpExit;
}

export interface FakeMcpServerOptions extends FakeMcpCatalog<FakeMcpProcessTool> {
  readonly startLog?: string;
  readonly startDelayMs?: number;
  readonly ignoreSigterm?: boolean;
  readonly exitBeforeConnect?: FakeMcpExit;
  readonly exitAfterConnect?: FakeMcpExit & { readonly whenFile: string };
}

export interface FakeMcpProcessSpec extends FakeMcpServerOptions {
  readonly name: string;
}

export interface FakeMcpStart {
  readonly server: string;
  readonly cwd: string;
}

export interface McpServerEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly deferred?: boolean;
}

export function fakeMcpServer(name: string, options: FakeMcpServerOptions): McpServerEntry {
  const spec: FakeMcpProcessSpec = { name, ...options };
  return { command: process.execPath, args: [FAKE_MCP_SERVER, JSON.stringify(spec)] };
}

export function fakeMcpServerName(args: readonly string[] | undefined): string | undefined {
  if (args?.[0] !== FAKE_MCP_SERVER || args[1] === undefined) return undefined;
  return (JSON.parse(args[1]) as Partial<FakeMcpProcessSpec>).name;
}

export async function writeMcpConfig(path: string, servers: Readonly<Record<string, McpServerEntry>>): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, 'utf8');
  return path;
}

export function readMcpCalls(callLog: string): Promise<readonly McpCall[]> {
  return readJsonLines<McpCall>(callLog);
}

export function readMcpStarts(startLog: string): Promise<readonly FakeMcpStart[]> {
  return readJsonLines<FakeMcpStart>(startLog);
}

async function readJsonLines<Line>(path: string): Promise<readonly Line[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Line);
}
