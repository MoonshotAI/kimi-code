import { dirname, join, normalize } from 'pathe';

import { resolveKimiHome } from '#/app/bootstrap/bootstrap';
import { findNearestGitMarker, locateCheckout } from '#/app/git/workTree';
import { groupsInto } from '#/app/workspace/implicitProject';
import type { Workspace } from '#/app/workspace/workspace';
import { resolvePath } from '#/_base/utils/paths';
import { toAbsoluteDir, workspaceRootKey } from '#/_base/utils/workdir-slug';
import { ErrorCodes, Error2 } from '#/errors';
import { McpServerConfigSchema, type McpServerConfig } from '#/mcpCore/config-schema';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { OsFsErrors, HostFsError } from '#/os/interface/hostFsErrors';

declare const mcpAnchorBrand: unique symbol;

export type McpAnchor = string & { readonly [mcpAnchorBrand]: true };

export interface KeyedMcpAnchor {
  readonly anchor: McpAnchor;
  readonly key: string;
}

export type McpAnchorScope = Pick<Workspace, 'root' | 'additionalDirs'>;

export function rootAnchor(projectRoot: string): McpAnchor {
  return projectRoot as McpAnchor;
}

export function keyedRootAnchor(projectRoot: string): KeyedMcpAnchor {
  return { anchor: rootAnchor(projectRoot), key: workspaceRootKey(normalize(projectRoot)) };
}

export async function findMcpAnchor(
  fs: IHostFileSystem,
  workDir: string,
  project: McpAnchorScope,
): Promise<KeyedMcpAnchor> {
  const start = normalize(workDir);
  const checkoutRoot = (await findNearestGitMarker(fs, start))?.root;
  const [here, root, checkout, ...additional] = await Promise.all([
    canonicalDir(fs, start),
    canonicalDir(fs, project.root),
    checkoutRoot === undefined ? undefined : canonicalDir(fs, checkoutRoot),
    ...project.additionalDirs.map((dir) => canonicalDir(fs, dir)),
  ]);
  const nearest = [isSameOrInside(here, root) ? root : undefined, checkout]
    .filter((dir) => dir !== undefined)
    .toSorted((a, b) => b.key.length - a.key.length)[0];
  if (nearest === undefined || nearest.key === root.key) return keyedRootAnchor(project.root);
  const inScope = [root, ...additional].some((scope) => isSameOrInside(nearest, scope)) ||
    (await groupsIntoRoot(fs, nearest.dir, root));
  return inScope ? { anchor: nearest.dir as McpAnchor, key: nearest.key } : keyedRootAnchor(project.root);
}

async function groupsIntoRoot(fs: IHostFileSystem, checkout: string, root: CanonicalDir): Promise<boolean> {
  const absolute = toAbsoluteDir(checkout);
  return absolute !== undefined && groupsInto(await locateCheckout(fs, absolute), root.key);
}

interface CanonicalDir {
  readonly dir: string;
  readonly key: string;
}

async function canonicalDir(fs: IHostFileSystem, dir: string): Promise<CanonicalDir> {
  const spelled = normalize(dir);
  try {
    return { dir: spelled, key: workspaceRootKey(normalize(await fs.realpath(spelled))) };
  } catch {
    return { dir: spelled, key: workspaceRootKey(spelled) };
  }
}

function isSameOrInside(dir: CanonicalDir, ancestor: CanonicalDir): boolean {
  return dir.key === ancestor.key || dir.key.startsWith(`${ancestor.key}/`);
}

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
  const projectRoot = (await findNearestGitMarker(input.fs, start))?.root ?? start;

  return {
    user: userMcpJsonPath(input.homeDir),
    projectRoot: join(projectRoot, '.mcp.json'),
    project: join(input.cwd, '.kimi-code', 'mcp.json'),
  };
}

export function userMcpJsonPath(homeDir?: string): string {
  return join(resolveKimiHome(homeDir), 'mcp.json');
}

export interface LoadMcpServersInput {
  readonly fs: IHostFileSystem;
  readonly cwd: string;
  readonly homeDir?: string;
  readonly includeProject?: boolean;
  readonly anchor?: McpAnchor;
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

export async function loadMcpServersDetailed(
  input: LoadMcpServersInput,
): Promise<LoadMcpServersDetailedResult> {
  if (input.includeProject === false) return loadUserMcpServers(input);
  const [user, anchor] = await Promise.all([
    loadUserMcpServers(input),
    loadAnchorMcpServers({ fs: input.fs, anchor: input.anchor ?? rootAnchor(input.cwd) }),
  ]);
  return mergeDetailed([user, anchor]);
}

export interface LoadUserMcpServersInput {
  readonly fs: IHostFileSystem;
  readonly homeDir?: string;
}

export async function loadUserMcpServers(
  input: LoadUserMcpServersInput,
): Promise<LoadMcpServersDetailedResult> {
  const path = userMcpJsonPath(input.homeDir);
  const servers = await readMcpJson(input.fs, path);
  return { servers, origins: mapValuesToPath(servers, path) };
}

export interface LoadAnchorMcpServersInput {
  readonly fs: IHostFileSystem;
  readonly anchor: McpAnchor;
}

export async function loadAnchorMcpServers(
  input: LoadAnchorMcpServersInput,
): Promise<LoadMcpServersDetailedResult> {
  const paths = await resolveMcpJsonPaths({ fs: input.fs, cwd: input.anchor });
  const [checkoutServers, anchorServers] = await Promise.all([
    readMcpJson(input.fs, paths.projectRoot, { stdioCwdBase: dirname(paths.projectRoot) }),
    readMcpJson(input.fs, paths.project),
  ]);
  return mergeDetailed([
    { servers: checkoutServers, origins: mapValuesToPath(checkoutServers, paths.projectRoot) },
    { servers: anchorServers, origins: mapValuesToPath(anchorServers, paths.project) },
  ]);
}

function mergeDetailed(
  layers: readonly LoadMcpServersDetailedResult[],
): LoadMcpServersDetailedResult {
  const servers: Record<string, McpServerConfig> = Object.create(null);
  const origins: Record<string, string> = Object.create(null);
  for (const layer of layers) {
    Object.assign(servers, layer.servers);
    Object.assign(origins, layer.origins);
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
