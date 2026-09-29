import { readFile, stat } from 'node:fs/promises';

import { dirname, isAbsolute, join, normalize, resolve } from 'pathe';

import { McpServerConfigSchema, type McpServerConfig } from '#/features/mcp/core/config-schema';

export interface McpJsonPaths {
  readonly user: string;
  readonly projectRoot: string;
  readonly project: string;
}

export async function resolveMcpJsonPaths(cwd: string, home: string): Promise<McpJsonPaths> {
  const start = normalize(cwd);
  const gitRoot = await findGitRoot(start);
  return {
    user: join(home, 'mcp.json'),
    projectRoot: join(gitRoot ?? start, '.mcp.json'),
    project: join(start, '.kimi-code', 'mcp.json'),
  };
}

export interface LoadMcpServersInput {
  readonly cwd: string;
  readonly home: string;
  readonly trusted: boolean;
  readonly servers?: Record<string, McpServerConfig>;
}

export interface LoadMcpServersDetailedResult {
  readonly servers: Record<string, McpServerConfig>;
  readonly origins: Record<string, string>;
}

export const MCP_PROPS_SERVERS_ORIGIN = 'props';

export async function loadMcpServers(input: LoadMcpServersInput): Promise<Record<string, McpServerConfig>> {
  return (await loadMcpServersDetailed(input)).servers;
}

export async function loadMcpServersDetailed(input: LoadMcpServersInput): Promise<LoadMcpServersDetailedResult> {
  const paths = await resolveMcpJsonPaths(input.cwd, input.home);
  const servers: Record<string, McpServerConfig> = Object.create(null);
  const origins: Record<string, string> = Object.create(null);
  for (const [name, config] of Object.entries(input.servers ?? {})) {
    servers[name] = config;
    origins[name] = MCP_PROPS_SERVERS_ORIGIN;
  }
  const user = await readMcpJson(paths.user);
  for (const [name, config] of Object.entries(user)) {
    servers[name] = config;
    origins[name] = paths.user;
  }
  if (input.trusted) {
    const projectRoot = await readMcpJson(paths.projectRoot, { stdioCwdBase: dirname(paths.projectRoot) });
    for (const [name, config] of Object.entries(projectRoot)) {
      servers[name] = config;
      origins[name] = paths.projectRoot;
    }
    const project = await readMcpJson(paths.project);
    for (const [name, config] of Object.entries(project)) {
      servers[name] = config;
      origins[name] = paths.project;
    }
  }
  return { servers, origins };
}

interface ReadMcpJsonOptions {
  readonly stdioCwdBase?: string;
}

async function readMcpJson(
  filePath: string,
  options: ReadMcpJsonOptions = {},
): Promise<Record<string, McpServerConfig>> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (isFileNotFound(error)) return {};
    throw new Error(`Failed to read ${filePath}: ${describeError(error)}`, { cause: error });
  }

  if (text.trim().length === 0) return {};

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error(`Invalid JSON in ${filePath}: ${describeError(error)}`, { cause: error });
  }

  try {
    return normalizeMcpServers(parseMcpJsonServers(data), options);
  } catch (error: unknown) {
    throw new Error(`Invalid MCP server config in ${filePath}: ${describeError(error)}`, { cause: error });
  }
}

function parseMcpJsonServers(data: unknown): Record<string, McpServerConfig> {
  if (!isRecord(data)) {
    throw new Error('expected a JSON object');
  }
  if (!('mcpServers' in data)) return {};
  const raw = data['mcpServers'];
  if (!isRecord(raw)) {
    throw new Error('"mcpServers" must be an object');
  }
  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [name, McpServerConfigSchema.parse(value)]),
  );
}

function normalizeMcpServers(
  servers: Record<string, McpServerConfig>,
  options: ReadMcpJsonOptions,
): Record<string, McpServerConfig> {
  const stdioCwdBase = options.stdioCwdBase;
  if (stdioCwdBase === undefined) return servers;

  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [
      name,
      normalizeStdioCwd(config, stdioCwdBase),
    ]),
  );
}

function normalizeStdioCwd(config: McpServerConfig, cwdBase: string): McpServerConfig {
  if (config.transport !== 'stdio') return config;
  const cwd = config.cwd === undefined ? cwdBase : resolve(cwdBase, config.cwd);
  return { ...config, cwd };
}

async function findGitRoot(cwd: string): Promise<string | undefined> {
  if (cwd.length === 0 || !isAbsolute(cwd)) return undefined;
  let current = normalize(cwd);
  for (;;) {
    if (await probeGitMarker(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function probeGitMarker(dotGitPath: string): Promise<boolean> {
  try {
    const stats = await stat(dotGitPath);
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
