import { readFile, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { dirname, isAbsolute, join, normalize, resolve } from 'pathe';

import { resolveKimiHome } from '#/config/path';
import { McpServerConfigSchema, type McpServerConfig } from '#/config/schema';
import { ErrorCodes, KimiError } from '#/errors';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the file's server map entry-by-entry instead of through a single
 * `z.record()`: a record parse rebuilds its output with property assignment,
 * which routes a literal `__proto__` server key through the prototype setter
 * and silently drops it. Per-entry parsing over the JSON own-keys keeps every
 * declared server.
 */
function parseMcpJsonServers(data: unknown): Record<string, McpServerConfig> {
  if (!isRecord(data)) throw new Error('expected a JSON object');
  const raw = data['mcpServers'] ?? {};
  if (!isRecord(raw)) throw new Error('"mcpServers" must be an object');
  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [name, McpServerConfigSchema.parse(value)]),
  );
}

export interface McpJsonPaths {
  readonly user: string;
  readonly projectRoot: string;
  readonly project: string;
}

export interface ResolveMcpJsonPathsInput {
  readonly cwd: string;
  readonly homeDir?: string;
}

export async function resolveMcpJsonPaths(input: ResolveMcpJsonPathsInput): Promise<McpJsonPaths> {
  const projectRoot = await findProjectRoot(input.cwd);

  return {
    user: join(resolveKimiHome(input.homeDir), 'mcp.json'),
    projectRoot: join(projectRoot, '.mcp.json'),
    project: join(input.cwd, '.kimi-code', 'mcp.json'),
  };
}

export interface LoadMcpServersInput {
  readonly cwd: string;
  readonly homeDir?: string;
}

export interface LoadMcpServersDetailedResult {
  /** Later layers override earlier ones with the same key. */
  readonly servers: Record<string, McpServerConfig>;
  /** The file each effective entry was last defined in. */
  readonly origins: Record<string, string>;
}

/**
 * Load MCP server declarations from the user-global `~/.kimi-code/mcp.json`,
 * the project-root `<project root>/.mcp.json`, and the project-local
 * `<cwd>/.kimi-code/mcp.json`. Entries in later files override earlier files
 * with the same key, so a repo can specialise or replace a shared definition,
 * and Kimi-specific project config wins over the Claude-compatible root file.
 *
 * Note: project-local entries may spawn stdio commands at session start, so
 * opening a session inside an untrusted checkout will execute whatever its
 * `mcp.json` declares. Only enable this in repos you trust.
 */
export async function loadMcpServers(
  input: LoadMcpServersInput,
): Promise<Record<string, McpServerConfig>> {
  return (await loadMcpServersDetailed(input)).servers;
}

/**
 * {@link loadMcpServers} plus the defining-file origin of every effective
 * entry, for management surfaces that show where a server came from.
 */
export async function loadMcpServersDetailed(
  input: LoadMcpServersInput,
): Promise<LoadMcpServersDetailedResult> {
  const paths = await resolveMcpJsonPaths({ cwd: input.cwd, homeDir: input.homeDir });
  const layers: readonly [path: string, servers: Record<string, McpServerConfig>][] =
    await Promise.all([
      readMcpJson(paths.user),
      readMcpJson(paths.projectRoot, { stdioCwdBase: dirname(paths.projectRoot) }),
      readMcpJson(paths.project),
    ]).then(([user, projectRoot, project]) => [
      [paths.user, user],
      [paths.projectRoot, projectRoot],
      [paths.project, project],
    ]);
  // Null-prototype accumulators: a server literally named `__proto__` would
  // otherwise hit the prototype setter and silently vanish from the merge.
  const servers: Record<string, McpServerConfig> = Object.create(null);
  const origins: Record<string, string> = Object.create(null);
  for (const [path, layer] of layers) {
    for (const [name, config] of Object.entries(layer)) {
      servers[name] = config;
      origins[name] = path;
    }
  }
  return { servers, origins };
}

async function findProjectRoot(cwd: string): Promise<string> {
  const start = normalize(cwd);
  let current = start;

  while (true) {
    if (await pathExists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: unknown) {
    if (isPathMissing(error)) return false;
    throw error;
  }
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
    text = await readFile(filePath, 'utf-8');
  } catch (error: unknown) {
    if (isFileNotFound(error)) return {};
    throw new KimiError(ErrorCodes.CONFIG_INVALID, `Failed to read ${filePath}: ${describeError(error)}`, {
      cause: error,
    });
  }

  if (text.trim().length === 0) return {};

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error: unknown) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, `Invalid JSON in ${filePath}: ${describeError(error)}`, {
      cause: error,
    });
  }

  try {
    return normalizeMcpServers(parseMcpJsonServers(data), options);
  } catch (error: unknown) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, `Invalid MCP server config in ${filePath}: ${describeError(error)}`, {
      cause: error,
    });
  }
}

function normalizeMcpServers(
  servers: Record<string, McpServerConfig>,
  options: ReadMcpJsonOptions,
): Record<string, McpServerConfig> {
  const stdioCwdBase = options.stdioCwdBase;
  if (stdioCwdBase === undefined) return servers;

  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [name, normalizeStdioCwd(config, stdioCwdBase)]),
  );
}

function normalizeStdioCwd(config: McpServerConfig, cwdBase: string): McpServerConfig {
  if (config.transport !== 'stdio') return config;
  const cwd = config.cwd === undefined ? cwdBase : resolvePath(cwdBase, config.cwd);
  return { ...config, cwd };
}

function resolvePath(base: string, value: string): string {
  if (isWindowsAbsolutePath(base)) {
    return win32.resolve(base, value).replaceAll('\\', '/');
  }
  if (isWindowsAbsolutePath(value)) {
    return win32.resolve(value).replaceAll('\\', '/');
  }
  return isAbsolute(value) ? normalize(value) : resolve(base, value);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

function isFileNotFound(error: unknown): boolean {
  return getErrorCode(error) === 'ENOENT';
}

function isPathMissing(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function getErrorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return (error as { code: unknown }).code;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
