import { dirname, isAbsolute, join, normalize, resolve } from 'pathe';

import { HostFsError, type OsFsPort } from '#/features/os/host/index';

import { McpServerConfigSchema, type McpServerConfig } from '../core/config-schema';

export interface McpJsonPaths {
  readonly user?: string;
  readonly projectRoot: string;
  readonly project: string;
}

export async function resolveMcpJsonPaths(
  fs: OsFsPort | undefined,
  cwd: string,
  home?: string,
): Promise<McpJsonPaths> {
  const start = normalize(cwd);
  const gitRoot = fs === undefined ? undefined : await findGitRoot(fs, start);
  return {
    user: home === undefined ? undefined : join(home, 'mcp.json'),
    projectRoot: join(gitRoot ?? start, '.mcp.json'),
    project: join(start, '.kimi-code', 'mcp.json'),
  };
}

export interface LoadMcpServersInput {
  readonly fs?: OsFsPort;
  readonly cwd: string;
  readonly home?: string;
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
  const paths = await resolveMcpJsonPaths(input.fs, input.cwd, input.home);
  const servers: Record<string, McpServerConfig> = Object.create(null);
  const origins: Record<string, string> = Object.create(null);
  for (const [name, config] of Object.entries(input.servers ?? {})) {
    servers[name] = config;
    origins[name] = MCP_PROPS_SERVERS_ORIGIN;
  }
  if (input.fs !== undefined && paths.user !== undefined) {
    const user = await readMcpJson(input.fs, paths.user);
    for (const [name, config] of Object.entries(user)) {
      servers[name] = config;
      origins[name] = paths.user;
    }
  }
  if (input.trusted && input.fs !== undefined) {
    const projectRoot = await readMcpJson(input.fs, paths.projectRoot, {
      stdioCwdBase: dirname(paths.projectRoot),
    });
    for (const [name, config] of Object.entries(projectRoot)) {
      servers[name] = config;
      origins[name] = paths.projectRoot;
    }
    const project = await readMcpJson(input.fs, paths.project);
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
  fs: OsFsPort,
  filePath: string,
  options: ReadMcpJsonOptions = {},
): Promise<Record<string, McpServerConfig>> {
  let text: string;
  try {
    text = await fs.readText(filePath);
  } catch (error: unknown) {
    if (error instanceof HostFsError && error.code === 'os.fs.not_found') return {};
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

async function findGitRoot(fs: OsFsPort, cwd: string): Promise<string | undefined> {
  if (cwd.length === 0 || !isAbsolute(cwd)) return undefined;
  let current = normalize(cwd);
  for (;;) {
    if (await probeGitMarker(fs, join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function probeGitMarker(fs: OsFsPort, dotGitPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dotGitPath);
    return stats.isDirectory || stats.isFile;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
