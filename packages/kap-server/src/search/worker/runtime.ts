import fs from 'node:fs';
import path from 'node:path';

export type SearchWorkerRuntimeState =
  | { readonly configured: false }
  | { readonly configured: true; readonly path: string };

let configuredPath: string | null = null;

export function configureSearchWorkerRuntime(entry: string): SearchWorkerRuntimeState {
  if (!path.isAbsolute(entry)) {
    throw new TypeError('search worker entry must be an absolute path');
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(entry);
  } catch (error) {
    throw new TypeError(
      `search worker entry is not readable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!stat.isFile()) {
    throw new TypeError('search worker entry must be a regular file');
  }
  if (configuredPath !== null) {
    if (configuredPath !== entry) {
      throw new Error('search worker runtime is already configured');
    }
    return { configured: true, path: configuredPath };
  }
  configuredPath = entry;
  return { configured: true, path: configuredPath };
}

export function resetSearchWorkerRuntime(): void {
  configuredPath = null;
}

export function getSearchWorkerRuntimeState(): SearchWorkerRuntimeState {
  return configuredPath === null
    ? { configured: false }
    : { configured: true, path: configuredPath };
}
