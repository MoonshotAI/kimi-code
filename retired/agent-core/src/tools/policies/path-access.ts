/**
 * Path safety guards used by Read/Write/Edit/Grep/Glob.
 *
 * Canonicalization is **lexical** by default (no `realpath` / symlink
 * following). An optional symlink-resolve pass (`resolveSymlinks`) uses
 * `fs.realpath` to detect symlink escapes on the local filesystem —
 * callers should enable it for write operations where the risk is
 * highest.
 *
 * Mirrors `KaosPath.canonical()` and keeps the guard backend-aware:
 * callers should pass the active Kaos path class so SSH paths stay POSIX
 * even when the host Node process is running on Windows.
 *
 * Shared-prefix escapes (a path like `/workspace-evil` passing a naive
 * `startswith('/workspace')` check) are blocked by requiring a path
 * separator (or exact equality) after the base prefix in
 * `isWithinDirectory`.
 */

import { realpath } from 'node:fs/promises';

import * as pathe from 'pathe';

import type { Kaos } from '@moonshot-ai/kaos';

import type { WorkspaceConfig } from '../support/workspace';
import { isSensitiveFile } from './sensitive';

export type PathClass = 'posix' | 'win32';
export type PathSecurityCode = 'PATH_OUTSIDE_WORKSPACE' | 'PATH_SENSITIVE' | 'PATH_INVALID';
export type PathAccessOperation = 'read' | 'write' | 'search';
export type WorkspaceGuardMode = 'absolute-outside-allowed' | 'disabled';

export interface WorkspaceAccessPolicy {
  readonly guardMode: WorkspaceGuardMode;
  readonly checkSensitive: boolean;
}

export const DEFAULT_WORKSPACE_ACCESS_POLICY: WorkspaceAccessPolicy = {
  guardMode: 'absolute-outside-allowed',
  checkSensitive: true,
};

export interface PathAccess {
  readonly path: string;
  readonly outsideWorkspace: boolean;
}

export class PathSecurityError extends Error {
  readonly code: PathSecurityCode;
  readonly rawPath: string;
  readonly canonicalPath: string;

  constructor(code: PathSecurityCode, rawPath: string, canonicalPath: string, message: string) {
    super(message);
    this.name = 'PathSecurityError';
    this.code = code;
    this.rawPath = rawPath;
    this.canonicalPath = canonicalPath;
  }
}

const DEFAULT_PATH_CLASS: PathClass = process.platform === 'win32' ? 'win32' : 'posix';

function isEnoentError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown })['code'];
  return code === 'ENOENT';
}

function isWin32DriveRelative(path: string): boolean {
  return /^[A-Za-z]:(?:$|[^\\/])/.test(path);
}

export function normalizeUserPath(path: string, pathClass: PathClass = DEFAULT_PATH_CLASS): string {
  if (pathClass !== 'win32') return path;

  // A bare root slash stays forward so downstream pathe operations
  // treat it consistently. Matches the py helper's behavior.
  if (path === '/') return '/';

  if (path.startsWith('//')) {
    return path;
  }

  const cygdriveMatch = /^\/cygdrive\/([A-Za-z])(?:\/|$)/.exec(path);
  if (cygdriveMatch !== null) {
    const drive = cygdriveMatch[1]!.toUpperCase();
    const rest = path.slice(`/cygdrive/${cygdriveMatch[1]!}`.length);
    return `${drive}:${rest === '' ? '/' : rest}`;
  }

  const driveMatch = /^\/([A-Za-z])(?:\/|$)/.exec(path);
  if (driveMatch !== null) {
    const drive = driveMatch[1]!.toUpperCase();
    const rest = path.slice(2);
    return `${drive}:${rest === '' ? '/' : rest}`;
  }

  return path;
}

function expandUserPath(path: string, homeDir: string | undefined, pathClass: PathClass): string {
  if (homeDir === undefined) return path;
  if (path === '~') return homeDir;
  if (path.startsWith('~/') || (pathClass === 'win32' && path.startsWith('~\\'))) {
    return pathe.join(homeDir, path.slice(2));
  }
  return path;
}

/**
 * Lexical canonicalization: resolve relative → absolute against `cwd`,
 * then normalize `..` / `.` segments. No filesystem I/O.
 */
export function canonicalizePath(
  path: string,
  cwd: string,
  pathClass: PathClass = DEFAULT_PATH_CLASS,
): string {
  if (path === '') {
    throw new PathSecurityError('PATH_INVALID', path, path, 'Path cannot be empty');
  }
  const normalizedPath = normalizeUserPath(path, pathClass);
  if (pathClass === 'win32' && isWin32DriveRelative(normalizedPath)) {
    throw new PathSecurityError(
      'PATH_INVALID',
      path,
      normalizedPath,
      `"${path}" is a drive-relative Windows path. Use an absolute path like C:\\path or a path relative to the working directory.`,
    );
  }
  if (!pathe.isAbsolute(normalizedPath) && !pathe.isAbsolute(cwd)) {
    throw new PathSecurityError(
      'PATH_INVALID',
      path,
      normalizedPath,
      `Cannot resolve "${path}" against non-absolute cwd "${cwd}".`,
    );
  }
  const abs = pathe.isAbsolute(normalizedPath) ? normalizedPath : pathe.resolve(cwd, normalizedPath);
  return pathe.normalize(abs);
}

/**
 * True iff `candidate` is `base` itself or a descendant of it, compared
 * on path-component boundaries. Both arguments must already be canonical.
 */
export function isWithinDirectory(
  candidate: string,
  base: string,
  pathClass: PathClass = DEFAULT_PATH_CLASS,
): boolean {
  const nc = pathe.normalize(candidate);
  const nb = pathe.normalize(base);
  const comparableCandidate = pathClass === 'win32' ? nc.toLowerCase() : nc;
  const comparableBase = pathClass === 'win32' ? nb.toLowerCase() : nb;
  if (comparableCandidate === comparableBase) return true;
  const prefix = comparableBase.endsWith('/') ? comparableBase : comparableBase + '/';
  return comparableCandidate.startsWith(prefix);
}

/**
 * True iff `candidate` (already canonical) sits inside any of the workspace
 * roots listed in `config` (primary `workspaceDir` or any `additionalDirs`).
 */
export function isWithinWorkspace(
  candidate: string,
  config: WorkspaceConfig,
  pathClass: PathClass = DEFAULT_PATH_CLASS,
): boolean {
  if (isWithinDirectory(candidate, config.workspaceDir, pathClass)) return true;
  for (const dir of config.additionalDirs) {
    if (isWithinDirectory(candidate, dir, pathClass)) return true;
  }
  return false;
}

export interface AssertPathOptions {
  readonly mode: PathAccessOperation;
  /** When true (default), also reject paths matching a sensitive-file pattern. */
  readonly checkSensitive?: boolean | undefined;
  readonly pathClass?: PathClass | undefined;
}

export interface ResolvePathAccessOptions {
  readonly operation: PathAccessOperation;
  readonly policy?: WorkspaceAccessPolicy | undefined;
  readonly pathClass?: PathClass | undefined;
  readonly homeDir?: string;
}

export interface ResolvePathAccessPathOptions {
  readonly kaos: Pick<Kaos, 'pathClass' | 'gethome'>;
  readonly workspace: WorkspaceConfig;
  readonly operation: PathAccessOperation;
  readonly policy?: WorkspaceAccessPolicy;
  readonly expandHome?: boolean;
}

function relativeOutsideMessage(path: string, operation: PathAccessOperation): string {
  const verb =
    operation === 'write'
      ? 'write or edit a file'
      : operation === 'search'
        ? 'search'
        : 'read a file';
  return (
    `"${path}" is not an absolute path. ` +
    `You must provide an absolute path to ${verb} outside the working directory.`
  );
}

export function resolvePathAccess(
  path: string,
  cwd: string,
  config: WorkspaceConfig,
  options: ResolvePathAccessOptions,
): PathAccess {
  if (path.includes('\0')) {
    throw new PathSecurityError(
      'PATH_INVALID',
      path,
      path,
      `"${path.replaceAll('\0', '\\0')}" contains a null byte and is not a valid path.`,
    );
  }
  const pathClass = options.pathClass ?? DEFAULT_PATH_CLASS;
  const normalizedPath = normalizeUserPath(path, pathClass);
  const expandedPath = expandUserPath(normalizedPath, options.homeDir, pathClass);
  const rawIsAbsolute = pathe.isAbsolute(expandedPath);
  const canonical = canonicalizePath(expandedPath, cwd, pathClass);
  const outsideWorkspace = !isWithinWorkspace(canonical, config, pathClass);
  const policy = options.policy ?? DEFAULT_WORKSPACE_ACCESS_POLICY;

  if (policy.checkSensitive && isSensitiveFile(canonical)) {
    throw new PathSecurityError(
      'PATH_SENSITIVE',
      path,
      canonical,
      `"${path}" matches a sensitive-file pattern (env / credential / SSH key). ` +
        `Access is blocked to protect secrets.`,
    );
  }

  if (outsideWorkspace) {
    switch (policy.guardMode) {
      case 'absolute-outside-allowed':
        if (!rawIsAbsolute) {
          throw new PathSecurityError(
            'PATH_OUTSIDE_WORKSPACE',
            path,
            canonical,
            relativeOutsideMessage(path, options.operation),
          );
        }
        break;
      case 'disabled':
        break;
    }
  }

  return { path: canonical, outsideWorkspace };
}

export function resolvePathAccessPath(
  path: string,
  options: ResolvePathAccessPathOptions,
): string {
  const { kaos, workspace, operation, policy, expandHome = true } = options;
  return resolvePathAccess(path, workspace.workspaceDir, workspace, {
    operation,
    policy,
    pathClass: kaos.pathClass(),
    homeDir: expandHome ? kaos.gethome() : undefined,
  }).path;
}

/**
 * Throw `PathSecurityError` if `path` escapes the workspace through a relative
 * path, matches a known sensitive file, or is empty. Returns the canonical
 * absolute path when the check passes.
 *
 * Note: the primary check is purely lexical. For write operations, callers
 * should additionally call {@link resolveSymlinkEscape} to detect symlink
 * targets that point outside the workspace.
 */
export function assertPathAllowed(
  path: string,
  cwd: string,
  config: WorkspaceConfig,
  options: AssertPathOptions,
): string {
  return resolvePathAccess(path, cwd, config, {
    operation: options.mode,
    pathClass: options.pathClass,
    policy: {
      guardMode: 'absolute-outside-allowed',
      checkSensitive: options.checkSensitive ?? DEFAULT_WORKSPACE_ACCESS_POLICY.checkSensitive,
    },
  }).path;
}

/**
 * Best-effort symlink-escape check: resolves `canonicalPath` via
 * `fs.realpath` and verifies the resolved target still falls within the
 * workspace roots. Returns the realpath if safe, or `undefined` if the
 * path does not exist (common for write-before-create), or throws
 * `PathSecurityError` if the symlink target escapes.
 *
 * This is an async, local-filesystem-only check. It should be called
 * after `assertPathAllowed` / `resolvePathAccess` for write operations
 * where the canonical path might traverse a symlink planted inside the
 * workspace that points outside.
 */
export async function resolveSymlinkEscape(
  canonicalPath: string,
  config: WorkspaceConfig,
  pathClass: PathClass = DEFAULT_PATH_CLASS,
): Promise<string | undefined> {
  // Only check for symlink escapes when the canonical path is inside the
  // workspace. A path that is already outside the workspace has been
  // explicitly allowed by the path access policy — there is no symlink
  // escape to detect.
  if (!isWithinWorkspace(canonicalPath, config, pathClass)) {
    return undefined;
  }
  let resolved: string;
  try {
    resolved = await realpath(canonicalPath);
  } catch {
    // ENOENT — file doesn't exist yet (write-create scenario).
    // Walk the parent chain to detect a symlink in the path prefix.
    const parent = pathe.dirname(canonicalPath);
    try {
      const resolvedParent = await realpath(parent);
      if (!(await isWithinResolvedWorkspace(resolvedParent, config, pathClass))) {
        throw new PathSecurityError(
          'PATH_OUTSIDE_WORKSPACE',
          canonicalPath,
          resolvedParent,
          `Symlink in path prefix resolves outside workspace: "${parent}" → "${resolvedParent}"`,
        );
      }
    } catch (e) {
      if (e instanceof PathSecurityError) throw e;
      if (!isEnoentError(e)) throw e;
      // Parent also doesn't exist — no symlink to follow, allow.
    }
    return undefined;
  }
  // realpath succeeded — check the resolved target.
  if (resolved !== canonicalPath && !(await isWithinResolvedWorkspace(resolved, config, pathClass))) {
    throw new PathSecurityError(
      'PATH_OUTSIDE_WORKSPACE',
      canonicalPath,
      resolved,
      `Symlink target resolves outside workspace: "${canonicalPath}" → "${resolved}"`,
    );
  }
  return resolved;
}

/**
 * Like {@link isWithinWorkspace} but resolves each workspace root through
 * `fs.realpath` before comparing, so that Windows short-name paths (e.g.
 * `ADMINI~1`) and symlinked roots are compared fairly against the
 * `realpath`-resolved candidate. Falls back to lexical comparison if a
 * workspace root cannot be resolved (non-existent path, permissions).
 */
async function isWithinResolvedWorkspace(
  candidate: string,
  config: WorkspaceConfig,
  pathClass: PathClass,
): Promise<boolean> {
  const roots = [config.workspaceDir, ...config.additionalDirs];
  for (const root of roots) {
    if (isWithinDirectory(candidate, root, pathClass)) return true;
    try {
      const resolvedRoot = await realpath(root);
      if (isWithinDirectory(candidate, resolvedRoot, pathClass)) return true;
    } catch {
      // Root doesn't exist or can't be resolved — skip, lexical check above suffices.
    }
  }
  return false;
}
