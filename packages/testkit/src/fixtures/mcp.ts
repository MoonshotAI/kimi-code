import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_MCP_SERVER = fileURLToPath(new URL('./mcp-server-process.ts', import.meta.url));

export interface FakeMcpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly reply?: string;
}

export interface FakeMcpServerOptions {
  readonly tools: readonly FakeMcpTool[];
  readonly callLog?: string;
}

export interface McpServerEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly deferred?: boolean;
}

export interface McpCall {
  readonly server: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export function fakeMcpServer(name: string, options: FakeMcpServerOptions): McpServerEntry {
  return { command: process.execPath, args: [FAKE_MCP_SERVER, JSON.stringify({ name, ...options })] };
}

export async function writeMcpConfig(path: string, servers: Readonly<Record<string, McpServerEntry>>): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, 'utf8');
  return path;
}

export async function readMcpCalls(callLog: string): Promise<readonly McpCall[]> {
  let text: string;
  try {
    text = await readFile(callLog, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as McpCall);
}
