/**
 * `agentFileCatalog` domain (L3) — shared path primitives for agent-file
 * discovery.
 *
 * `~` expansion, base-relative resolution, and `hostFs` type probes used by
 * the root resolvers, the directory walker, and the explicit-file source.
 * Pure helpers; no scoped state.
 */

import { isAbsolute, join, resolve } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

/**
 * Expand a leading `~` to `osHomeDir` and resolve relative paths against
 * `baseDir`. Callers pick the base: discovery roots resolve against the
 * project root, explicit files against the session workDir.
 */
export function resolveAgentPath(path: string, baseDir: string, osHomeDir: string): string {
  if (path === '~') return osHomeDir;
  if (path.startsWith('~/')) return join(osHomeDir, path.slice(2));
  if (isAbsolute(path)) return path;
  return resolve(baseDir, path);
}

export async function isDirectoryPath(fs: IHostFileSystem, p: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(p);
    return (await fs.stat(resolved)).isDirectory;
  } catch {
    return false;
  }
}

export async function isFilePath(fs: IHostFileSystem, p: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(p);
    return (await fs.stat(resolved)).isFile;
  } catch {
    return false;
  }
}

export async function pathExists(fs: IHostFileSystem, p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
