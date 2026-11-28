import { dirname, join, normalize } from 'pathe';

import { resolveKimiHome } from '#/app/bootstrap/bootstrap';
import { findGitWorkTree } from '#/app/git/workTree';
import { resolvePath } from '#/_base/utils/paths';
import { ErrorCodes, Error2 } from '#/errors';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import {
  McpServerConfigEntrySchema,
  isMcpServerConfig,
  type McpServerConfigEntry,
} from '#/mcpCore/config-override';
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
  readonly servers: Record<string, McpServerConfig>;
  readonly origins: Record<string, string>;
}

export async function loadMcpServers(
  input: LoadMcpServersInput,
): Promise<Record<string, McpServerConfig>> {
  return (await loadMcpServersDetailed(input)).servers;
}

export type McpFileSourceId = 'user' | 'project-root' | 'workspace';

export interface McpConfigLayer {
  readonly sourceId: McpFileSourceId;
  readonly origin: string;
  readonly servers: Record<string, McpServerConfigEntry>;
}

export async function loadMcpConfigLayers(
  input: LoadMcpServersInput,
): Promise<readonly McpConfigLayer[]> {
  const paths = await resolveMcpJsonPaths(input);
  const user: McpConfigLayer = {
    sourceId: 'user',
    origin: paths.user,
    servers: await readMcpJson(input.fs, paths.user),
  };
  if (input.includeProject === false) return [user];
  const [projectRoot, project] = await Promise.all([
    readMcpJson(input.fs, paths.projectRoot, { stdioCwdBase: dirname(paths.projectRoot) }),
    readMcpJson(input.fs, paths.project),
  ]);
  return [
    user,
    { sourceId: 'project-root', origin: paths.projectRoot, servers: projectRoot },
    { sourceId: 'workspace', origin: paths.project, servers: project },
  ];
}

export function mergeMcpServerEntries(
  layers: readonly Record<string, McpServerConfigEntry>[],
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = Object.create(null);
  for (const layer of layers) {
    for (const [name, entry] of Object.entries(layer)) {
      if (isMcpServerConfig(entry)) {
        servers[name] = entry;
        continue;
      }
      const previous = servers[name];
      if (previous === undefined) continue;
      servers[name] = { ...previous, ...entry };
    }
  }
  return servers;
}

export async function loadMcpServersDetailed(
  input: LoadMcpServersInput,
): Promise<LoadMcpServersDetailedResult> {
  const layers = await loadMcpConfigLayers(input);
  const servers: Record<string, McpServerConfig> = Object.create(null);
  const origins: Record<string, string> = Object.create(null);
  for (const layer of layers) {
    for (const name of Object.keys(layer.servers)) {
      origins[name] = layer.origin;
    }
  }
  const merged = mergeMcpServerEntries(layers.map((layer) => layer.servers));
  for (const [name, config] of Object.entries(merged)) {
    servers[name] = config;
    origins[name] ??= layers[0]!.origin;
  }
  return { servers, origins };
}

interface ReadMcpJsonOptions {
  readonly stdioCwdBase?: string;
}

export async function readMcpJson(
  fs: IHostFileSystem,
  filePath: string,
  options: ReadMcpJsonOptions = {},
): Promise<Record<string, McpServerConfigEntry>> {
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

function parseMcpJsonServers(data: unknown): Record<string, McpServerConfigEntry> {
  if (!isRecord(data)) {
    throw new Error('expected a JSON object');
  }
  if (!('mcpServers' in data)) return {};
  const raw = data['mcpServers'];
  if (!isRecord(raw)) {
    throw new Error('"mcpServers" must be an object');
  }
  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [name, McpServerConfigEntrySchema.parse(value)]),
  );
}

function normalizeMcpServers(
  servers: Record<string, McpServerConfigEntry>,
  options: ReadMcpJsonOptions,
): Record<string, McpServerConfigEntry> {
  const stdioCwdBase = options.stdioCwdBase;
  if (stdioCwdBase === undefined) return servers;

  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [
      name,
      isMcpServerConfig(config) ? normalizeStdioCwd(config, stdioCwdBase) : config,
    ]),
  );
}

function normalizeStdioCwd(config: McpServerConfig, cwdBase: string): McpServerConfig {
  if (config.transport !== 'stdio') return config;
  const cwd = config.cwd === undefined ? cwdBase : resolvePath(cwdBase, config.cwd);
  return { ...config, cwd };
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
