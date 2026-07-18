import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'pathe';

import { resolveKimiHome } from '#/app/bootstrap/bootstrap';
import { McpServerConfigSchema, type McpServerConfig } from './config-schema';
import { ErrorCodes, Error2 } from '#/errors';
import { t } from '@moonshot-ai/kimi-i18n';
import { z } from 'zod';

const McpJsonFileSchema = z.object({
  mcpServers: z.record(z.string(), McpServerConfigSchema).default({}),
});

export interface McpJsonPaths {
  readonly user: string;
  readonly projectRoot: string;
  readonly project: string;
}

/**
 * Origin of an MCP server configuration. ``project-root`` configs come
 * from ``<repoRoot>/.mcp.json`` (typically checked into git) and are
 * treated as untrusted: their stdio servers require explicit user
 * approval before kimi-code will spawn them.
 */
export type McpConfigSource = 'user' | 'project-root' | 'project';

export interface SourcedMcpServerConfig {
  readonly config: McpServerConfig;
  readonly source: McpConfigSource;
}

export interface ResolveMcpJsonPathsInput {
  readonly cwd: string;
  readonly homeDir?: string;
}

export async function resolveMcpJsonPaths(input: ResolveMcpJsonPathsInput): Promise<McpJsonPaths> {
  const projectRoot = await findProjectRoot(input.cwd);
  const kimiHome = resolveKimiHome(input.homeDir);

  return {
    user: join(kimiHome, 'mcp.json'),
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
  const sourced = await loadMcpServersWithSources(input);
  return Object.fromEntries(Object.entries(sourced).map(([k, v]) => [k, v.config]));
}

/**
 * Like {@link loadMcpServers} but tags each entry with its origin so the
 * connection manager can apply trust policies (e.g. requiring approval
 * for stdio servers sourced from ``<repoRoot>/.mcp.json``).
 */
export async function loadMcpServersWithSources(
  input: LoadMcpServersInput,
): Promise<Record<string, SourcedMcpServerConfig>> {
  const paths = await resolveMcpJsonPaths({ cwd: input.cwd, homeDir: input.homeDir });
  const [user, projectRoot, project] = await Promise.all([
    readMcpJson(paths.user),
    readMcpJson(paths.projectRoot, { stdioCwdBase: dirname(paths.projectRoot) }),
    readMcpJson(paths.project),
  ]);
  const merged: Record<string, SourcedMcpServerConfig> = {};
  for (const [name, config] of Object.entries(user)) merged[name] = { config, source: 'user' };
  for (const [name, config] of Object.entries(projectRoot)) merged[name] = { config, source: 'project-root' };
  for (const [name, config] of Object.entries(project)) merged[name] = { config, source: 'project' };
  return merged;
}

const MAX_PROJECT_ROOT_DEPTH = 64;

async function findProjectRoot(cwd: string): Promise<string> {
  const start = normalize(cwd);
  let current = start;
  let depth = 0;

  while (true) {
    if (depth++ >= MAX_PROJECT_ROOT_DEPTH) return start;
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
    throw new Error2(ErrorCodes.CONFIG_INVALID, t('v2Errors.mcpFileReadFailed', { filePath, error: String(error) }), {
      cause: error,
    });
  }

  if (text.trim().length === 0) return {};

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, t('v2Errors.mcpJsonParseFailed', { filePath, error: String(error) }), {
      cause: error,
    });
  }

  try {
    return normalizeMcpServers(McpJsonFileSchema.parse(data).mcpServers, options);
  } catch (error: unknown) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, t('v2Errors.mcpSchemaInvalid', { filePath, error: String(error) }), {
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
