import type { AppState } from '#/tui/types';

/**
 * The directory the session actually works in: a remote binding's cwd, else
 * the local work dir. `AppState.workDir` stays the local launch directory
 * (workspace grouping, export save location, input history).
 */
export function sessionWorkDir(appState: Pick<AppState, 'workDir' | 'environment'>): string {
  const { environment } = appState;
  return environment !== undefined && environment.environmentId !== 'local' && environment.cwd !== undefined
    ? environment.cwd
    : appState.workDir;
}
