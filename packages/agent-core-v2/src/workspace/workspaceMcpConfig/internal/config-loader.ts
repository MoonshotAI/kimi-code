import { dirname, isAbsolute, join, normalize, resolve } from 'pathe';

import { findGitWorkTree } from '#/app/git/workTree';
import { resolveKimiHome } from '#/app/bootstrap/bootstrap';
import { OsFsErrors, HostFsError } from '#/os/interface/hostFsErrors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { McpServerConfigSchema, type McpServerConfig } from '#/mcpCore/config-schema';
import { ErrorCodes, Error2 } from '#/errors';
import { z } from 'zod';

const McpJsonFileSchema = z.object({
  mcpServers: z.record(z.string(), McpServerConfigSchema).default({}),
});

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

export async function loadMcpServers(
  input: LoadMcpServersInput,
): Promise<Record<string, McpServerConfig>> {
  const paths = await resolveMcpJsonPaths(input);
  if (input.includeProject === false) {
    return readMcpJson(input.fs, paths.user);
  }
  const [user, projectRoot, project] = await Promise.all([
    readMcpJson(input.fs, paths.user),
    readMcpJson(input.fs, paths.projectRoot, { stdioCwdBase: dirname(paths.projectRoot) }),
    readMcpJson(input.fs, paths.project),
  ]);
  return { ...user, ...projectRoot, ...project };
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
    throw new Error2(ErrorCodes.CONFIG_INVALID, `Failed to read ${filePath}: ${describeError(error)}`, {
      cause: error,
    });
  }

  if (text.trim().length === 0) return {};

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, `Invalid JSON in ${filePath}: ${describeError(error)}`, {
      cause: error,
    });
  }

  try {
    return normalizeMcpServers(McpJsonFileSchema.parse(data).mcpServers, options);
  } catch (error: unknown) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, `Invalid MCP server config in ${filePath}: ${describeError(error)}`, {
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
  return isAbsolute(value) ? normalize(value) : resolve(base, value);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_NOT_FOUND;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
