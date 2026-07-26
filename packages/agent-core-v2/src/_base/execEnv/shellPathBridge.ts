/**
 * `_base/execEnv` (L0) — shell path bridge: translate between native win32
 * paths and the POSIX path dialect spoken by the MSYS2 / Git Bash shell.
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
 * Vendored from `@moonshot-ai/kaos` `shell-path-bridge.ts` — kept as a pure
 * helper with no DI dependencies.
 */

import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';

import type { HostEnvironmentInfo } from './environmentProbe';

export interface ShellPathBridge {
  toShellPath(nativePath: string): string;
  fromShellPath(path: string): string;
}

export type ShellPathBridgeEnv = Pick<HostEnvironmentInfo, 'osKind' | 'shellName' | 'shellPath'>;

export interface ShellPathBridgeDeps {
  readonly execFileSync: (file: string, args: readonly string[]) => string;
  readonly isFile: (path: string) => boolean;
}

const CYGPATH_TIMEOUT_MS = 5_000;

const DRIVE_COLON_RE = /^\/([a-zA-Z]):(?:[\\/]|$)/;
const CYGDRIVE_RE = /^\/cygdrive\/([a-zA-Z])(?:\/|$)/;
const DRIVE_RE = /^\/([a-zA-Z])(?:\/|$)/;

const VIRTUAL_FS_PREFIXES: readonly string[] = ['/dev/', '/proc/', '/sys/'];

const WIN32_DRIVE_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;

function joinDrive(letter: string, rest: string): string {
  const normalizedRest = rest.replaceAll('\\', '/');
  return normalizedRest === ''
    ? `${letter.toUpperCase()}:/`
    : `${letter.toUpperCase()}:${normalizedRest}`;
}

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

  let cygpathExe: string | null | undefined;
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

    if (path.startsWith('//')) return path;

    if (path.startsWith('/')) {
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

const bridgeCache = new WeakMap<ShellPathBridgeEnv, ShellPathBridge>();

export function getShellPathBridge(env: ShellPathBridgeEnv): ShellPathBridge {
  const cached = bridgeCache.get(env);
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
  bridgeCache.set(env, bridge);
  return bridge;
}
