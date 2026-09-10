/**
 * Shell path bridge — translate between native win32 paths and the POSIX
 * path dialect spoken by the MSYS2 / Git Bash shell.
 *
 * The msys runtime gives the shell a POSIX path view native Node.js cannot
 * resolve (`/c/Users/x` is `C:\Users\x`; `/tmp/x` is `%TEMP%\x`, not
 * `<git-root>/tmp`). `toShellPath` renders native paths for bash command
 * lines; `fromShellPath` resolves model/shell-supplied paths for fs access,
 * translating drive-letter forms lexically and other root-relative paths
 * through `cygpath -w` next to the probed bash. Anything unconvertible
 * passes through unchanged, and both directions are identity outside win32
 * bash.
 *
 * Synchronous and self-contained (node builtins only):
 * `createShellPathBridge` takes injectable deps for tests;
 * `getShellPathBridge` bundles the Node defaults, memoised per env object.
 */

import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';

import type { Environment } from './environment';

export interface ShellPathBridge {
  /** Native win32 path → shell dialect, for building bash commands. Identity on posix. */
  toShellPath(nativePath: string): string;
  /** Model/shell-supplied path → native, for fs access. Identity when not convertible. */
  fromShellPath(path: string): string;
}

export type ShellPathBridgeEnv = Pick<Environment, 'osKind' | 'shellName' | 'shellPath'>;

export interface ShellPathBridgeDeps {
  readonly execFileSync: (file: string, args: readonly string[]) => string;
  readonly isFile: (path: string) => boolean;
}

const CYGPATH_TIMEOUT_MS = 5_000;

const DRIVE_COLON_RE = /^\/([a-zA-Z]):(?:[\\/]|$)/;
const CYGDRIVE_RE = /^\/cygdrive\/([a-zA-Z])(?:\/|$)/;
const DRIVE_RE = /^\/([a-zA-Z])(?:\/|$)/;

// cygpath semantics are undefined for the virtual filesystems.
const VIRTUAL_FS_PREFIXES: readonly string[] = ['/dev/', '/proc/', '/sys/'];

const WIN32_DRIVE_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;

function joinDrive(letter: string, rest: string): string {
  const normalizedRest = rest.replaceAll('\\', '/');
  return normalizedRest === ''
    ? `${letter.toUpperCase()}:/`
    : `${letter.toUpperCase()}:${normalizedRest}`;
}

/**
 * Lexical translation of shell-dialect drive paths (`/c/x`, `/c:/x`,
 * `/cygdrive/c/x`) to native win32 form — pure string rewriting, no cygpath
 * involved. Anything else is returned unchanged.
 */
export function translateShellDrivePath(path: string): string {
  const colonMatch = DRIVE_COLON_RE.exec(path);
  if (colonMatch !== null) {
    return joinDrive(colonMatch[1]!, path.slice(3));
  }
  const cygdriveMatch = CYGDRIVE_RE.exec(path);
  if (cygdriveMatch !== null) {
    return joinDrive(cygdriveMatch[1]!, path.slice(`/cygdrive/${cygdriveMatch[1]!}`.length));
  }
  const driveMatch = DRIVE_RE.exec(path);
  if (driveMatch !== null) {
    return joinDrive(driveMatch[1]!, path.slice(2));
  }
  return path;
}

export function createShellPathBridge(
  env: ShellPathBridgeEnv,
  deps: ShellPathBridgeDeps,
): ShellPathBridge {
  const enabled = env.osKind === 'Windows' && env.shellName === 'bash';

  // Lazily located on first use; `null` = not found → permanent pass-through.
  let cygpathExe: string | null | undefined;
  // Cache successes only: a missing cygpath.exe is a stable fact, but an
  // execution failure may be transient. First-segment caching is exact for
  // default (first-level) mount tables; deeper user mounts are out of scope.
  const segmentCache = new Map<string, string>();

  function locateCygpath(): string | null {
    if (cygpathExe !== undefined) return cygpathExe;
    const shellDir = nodePath.win32.dirname(env.shellPath);
    const candidates = [nodePath.win32.join(shellDir, 'cygpath.exe')];
    if (nodePath.win32.basename(shellDir).toLowerCase() === 'bin') {
      candidates.push(nodePath.win32.join(shellDir, '..', 'usr', 'bin', 'cygpath.exe'));
    }
    cygpathExe = candidates.find((candidate) => deps.isFile(candidate)) ?? null;
    return cygpathExe;
  }

  function resolveRootSegment(firstSegment: string): string | null {
    const cached = segmentCache.get(firstSegment);
    if (cached !== undefined) return cached;

    const exe = locateCygpath();
    if (exe === null) return null;
    let resolved: string;
    try {
      const output = deps.execFileSync(exe, ['-w', '-C', 'UTF8', '--', `/${firstSegment}`]);
      // cygpath appends a newline and may emit a trailing separator (`D:\`).
      const trimmed = output.replace(/\r?\n$/, '');
      if (!WIN32_DRIVE_ABSOLUTE_RE.test(trimmed) && !trimmed.startsWith('\\\\')) return null;
      resolved = trimmed.replace(/[\\/]$/, '');
    } catch {
      return null;
    }
    segmentCache.set(firstSegment, resolved);
    return resolved;
  }

  function fromShellPath(path: string): string {
    if (!enabled) return path;

    // Keep UNC out first: posix.normalize would collapse the leading `//`.
    if (path.startsWith('//')) return path;

    if (path.startsWith('/')) {
      // Fold dot segments first: `/tmp/..` is `/` in the shell VFS, not `%TEMP%\..`.
      const normalized = nodePath.posix.normalize(path);
      const lexical = translateShellDrivePath(normalized);
      if (lexical !== normalized) return lexical;
      if (normalized === '/') return normalized;
      if (VIRTUAL_FS_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return normalized;
      const firstSegment = normalized.slice(1).split('/')[0]!;
      const prefix = resolveRootSegment(firstSegment);
      if (prefix === null) return normalized;
      const remainder = normalized.slice(firstSegment.length + 1);
      const joined = `${prefix}${remainder}`.replaceAll('\\', '/');
      // A mounted drive root resolved from a bare segment (`D:`) stays absolute.
      return /^[A-Za-z]:$/.test(joined) ? `${joined}/` : joined;
    }

    return path;
  }

  function toShellPath(nativePath: string): string {
    if (!enabled) return nativePath;

    if (nativePath.startsWith('\\\\')) {
      return nativePath.replaceAll('\\', '/');
    }

    const driveMatch = /^([A-Za-z]):(?:[\\/]|$)/.exec(nativePath);
    if (driveMatch !== null) {
      const drive = driveMatch[1]!.toLowerCase();
      const rest = nativePath.slice(2).replaceAll('\\', '/');
      return `/${drive}${rest.startsWith('/') ? rest : `/${rest}`}`;
    }

    return nativePath.replaceAll('\\', '/');
  }

  return { toShellPath, fromShellPath };
}

const bridgeCache = new Map<string, ShellPathBridge>();

/**
 * Production convenience — Node's ambient `execFileSync` / `existsSync`,
 * memoised per shell identity so call sites that wrap the same probed
 * environment in a fresh object still share one bridge.
 */
export function getShellPathBridge(env: ShellPathBridgeEnv): ShellPathBridge {
  const key = `${env.osKind} ${env.shellName} ${env.shellPath}`;
  const cached = bridgeCache.get(key);
  if (cached !== undefined) return cached;
  const bridge = createShellPathBridge(env, {
    execFileSync: (file, args) =>
      nodeExecFileSync(file, [...args], {
        encoding: 'utf8',
        timeout: CYGPATH_TIMEOUT_MS,
        windowsHide: true,
      }),
    isFile: (path) => existsSync(path),
  });
  bridgeCache.set(key, bridge);
  return bridge;
}
