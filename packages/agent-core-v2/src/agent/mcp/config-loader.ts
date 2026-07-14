import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'pathe';

import { resolveKimiHome } from '#/app/bootstrap/bootstrap';
import { McpServerConfigSchema, type McpServerConfig } from './config-schema';
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

export async function loadMcpServers(
  input: LoadMcpServersInput,
): Promise<Record<string, McpServerConfig>> {
  const paths = await resolveMcpJsonPaths({ cwd: input.cwd, homeDir: input.homeDir });
  const [user, projectRoot, project] = await Promise.all([
    readMcpJson(paths.user),
    readMcpJson(paths.projectRoot, { stdioCwdBase: dirname(paths.projectRoot) }),
    readMcpJson(paths.project),
  ]);
  return { ...user, ...projectRoot, ...project };
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
