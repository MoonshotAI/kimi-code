import fs from 'node:fs';
import path from 'node:path';

export type SearchWorkerRuntimeState =
  | { readonly configured: false }
  | { readonly configured: true; readonly path: string };

let configuredPath: string | null = null;

/** Configure the packaged search worker entry once during process startup. */
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

/** Reset process-wide configuration. Intended for tests and controlled hosts. */
export function resetSearchWorkerRuntime(): void {
  configuredPath = null;
}

export function getSearchWorkerRuntimeState(): SearchWorkerRuntimeState {
  return configuredPath === null
    ? { configured: false }
    : { configured: true, path: configuredPath };
}
