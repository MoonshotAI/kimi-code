import { isAbsolute, join, resolve } from 'pathe';

import { HostFsError, type OsFsPort } from '#/features/os/host/index';

export function resolveAgentPath(path: string, baseDir: string, osHomeDir: string): string {
  if (path === '~') return osHomeDir;
  if (path.startsWith('~/')) return join(osHomeDir, path.slice(2));
  if (isAbsolute(path)) return path;
  return resolve(baseDir, path);
}

export async function isDirectoryPath(fs: OsFsPort, p: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(p);
    return (await fs.stat(resolved)).isDirectory;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

export async function isFilePath(fs: OsFsPort, p: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(p);
    return (await fs.stat(resolved)).isFile;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

export async function pathExists(fs: OsFsPort, p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof HostFsError &&
    (error.code === 'os.fs.not_found' || error.code === 'os.fs.not_directory')
  );
}
