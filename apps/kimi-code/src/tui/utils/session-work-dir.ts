import type { AppState } from '#/tui/types';

export function sessionWorkDir(appState: Pick<AppState, 'cwd' | 'environment'>): string {
  const { environment } = appState;
  return environment !== undefined && environment.environmentId !== 'local' && environment.cwd !== undefined
    ? environment.cwd
    : appState.cwd;
}

export function sessionWorktree(appState: Pick<AppState, 'worktree' | 'environment'>): AppState['worktree'] {
  const { environment } = appState;
  return environment === undefined || environment.environmentId === 'local' ? appState.worktree : undefined;
}
