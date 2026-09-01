import { stat } from 'node:fs/promises';

import { mergeLoginShellPath } from './loginShellPath';

export interface SystemBinPathDeps {
  readonly platform: string;
  readonly env: Record<string, string | undefined>;
  readonly isDir: (path: string) => Promise<boolean>;
}

const OHOS_SYSTEM_BIN_DIRS: readonly string[] = ['/system/bin', '/bin'];

export async function probeSystemBinPath(deps: SystemBinPathDeps): Promise<string | undefined> {
  if (deps.platform !== 'openharmony') return undefined;
  const found: string[] = [];
  for (const dir of OHOS_SYSTEM_BIN_DIRS) {
    if (await deps.isDir(dir)) found.push(dir);
  }
  return found.length === 0 ? undefined : found.join(':');
}

export async function applySystemBinPath(deps: SystemBinPathDeps): Promise<void> {
  const additions = await probeSystemBinPath(deps);
  if (additions === undefined) return;
  const currentPath = deps.env['PATH'];
  const merged = mergeLoginShellPath(currentPath, additions);
  if (merged === (currentPath ?? '')) return;
  deps.env['PATH'] = merged;
}

let appliedSystemBinPath: Promise<void> | undefined;

export function applySystemBinPathFromNode(): Promise<void> {
  if (appliedSystemBinPath !== undefined) return appliedSystemBinPath;
  appliedSystemBinPath = applySystemBinPath({
    platform: process.platform,
    env: process.env as Record<string, string | undefined>,
    isDir: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
  });
  return appliedSystemBinPath;
}
