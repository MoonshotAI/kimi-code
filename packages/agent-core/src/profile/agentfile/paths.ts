/**
 * Shared path primitives for agent-file discovery: `~` expansion,
 * base-relative resolution, and fs type probes used by the root resolvers,
 * the directory walker, and the explicit-file source. Callers pick the
 * resolution base: discovery roots resolve against the project root,
 * explicit files against the session workDir.
 *
 * Ported from the v2 engine (`packages/agent-core-v2/src/app/agentFileCatalog/paths.ts`)
 * — keep the two in sync.
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'pathe';

export function resolveAgentPath(path: string, baseDir: string, osHomeDir: string): string {
  if (path === '~') return osHomeDir;
  if (path.startsWith('~/')) return join(osHomeDir, path.slice(2));
  if (isAbsolute(path)) return path;
  return resolve(baseDir, path);
}

export async function isDirectoryPath(p: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(p);
    return (await fs.stat(resolved)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

export async function isFilePath(p: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(p);
    return (await fs.stat(resolved)).isFile();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

export function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
