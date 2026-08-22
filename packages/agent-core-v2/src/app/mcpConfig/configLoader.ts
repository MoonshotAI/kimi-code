import { dirname, join, normalize } from 'pathe';

import { resolveKimiHome } from '#/app/bootstrap/bootstrap';
import { findGitWorkTree } from '#/app/git/workTree';
import { resolvePath } from '#/_base/utils/paths';
import { ErrorCodes, Error2 } from '#/errors';
import { McpServerConfigSchema, type McpServerConfig } from '#/mcpCore/config-schema';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { OsFsErrors, HostFsError } from '#/os/interface/hostFsErrors';

export interface McpJsonPaths {
  readonly user: string;
  readonly projectRoot: string;
  readonly project: string;
}

export interface ResolveMcpJsonPathsInput {
  readonly fs: IHostFileSystem;
  readonly cwd: string;
  readonly homeDir?: string;
}

export async function resolveMcpJsonPaths(input: ResolveMcpJsonPathsInput): Promise<McpJsonPaths> {
  const start = normalize(input.cwd);
  const projectRoot = (await findGitWorkTree(input.fs, start))?.root ?? start;

  return {
    user: join(resolveKimiHome(input.homeDir), 'mcp.json'),
    projectRoot: join(projectRoot, '.mcp.json'),
    project: join(input.cwd, '.kimi-code', 'mcp.json'),
  };
}

export interface LoadMcpServersInput {
  readonly fs: IHostFileSystem;
  readonly cwd: string;
  readonly homeDir?: string;
  readonly includeProject?: boolean;
}

export interface LoadMcpServersDetailedResult {
  /** Later layers override earlier ones with the same key. */
  readonly servers: Record<string, McpServerConfig>;
  /** The file each effective entry was last defined in. */
  readonly origins: Record<string, string>;
}

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
  const paths = await resolveMcpJsonPaths(input);
  if (input.includeProject === false) {
    const user = await readMcpJson(input.fs, paths.user);
    return { servers: user, origins: mapValuesToPath(user, paths.user) };
  }
  const layers: readonly [path: string, servers: Record<string, McpServerConfig>][] =
    await Promise.all([
      readMcpJson(input.fs, paths.user),
      readMcpJson(input.fs, paths.projectRoot, { stdioCwdBase: dirname(paths.projectRoot) }),
      readMcpJson(input.fs, paths.project),
    ]).then(([user, projectRoot, project]) => [
      [paths.user, user],
      [paths.projectRoot, projectRoot],
      [paths.project, project],
    ]);
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

interface ReadMcpJsonOptions {
  readonly stdioCwdBase?: string;
}

async function readMcpJson(
  fs: IHostFileSystem,
  filePath: string,
  options: ReadMcpJsonOptions = {},
): Promise<Record<string, McpServerConfig>> {
  let text: string;
  try {
    text = await fs.readText(filePath);
  } catch (error: unknown) {
    if (isFileNotFound(error)) return {};
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Failed to read ${filePath}: ${describeError(error)}`,
      {
        cause: error,
      },
    );
  }

  if (text.trim().length === 0) return {};

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Invalid JSON in ${filePath}: ${describeError(error)}`,
      {
        cause: error,
      },
    );
  }

  try {
    return normalizeMcpServers(parseMcpJsonServers(data), options);
  } catch (error: unknown) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Invalid MCP server config in ${filePath}: ${describeError(error)}`,
      {
        cause: error,
      },
    );
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
  const cwd = config.cwd === undefined ? cwdBase : resolvePath(cwdBase, config.cwd);
  return { ...config, cwd };
}

function mapValuesToPath(
  servers: Record<string, McpServerConfig>,
  path: string,
): Record<string, string> {
  const origins: Record<string, string> = Object.create(null);
  for (const name of Object.keys(servers)) {
    origins[name] = path;
  }
  return origins;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_NOT_FOUND;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
