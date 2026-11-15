import type { ExecutableToolErrorResult } from '#/tool/toolContract';

import type { IArtexGraphStore } from '#/features/artex/store/artexGraphStore';
import type { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import type { IArtexWorkStore } from '#/features/artex/store/artexWorkStore';
import type { IArtexWorkStoreProvider } from '#/features/artex/store/artexWorkStoreProvider';
import type { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';

export const ARTEX_INACTIVE_RESULT: ExecutableToolErrorResult = {
  output:
    'ARTEX is not active in this session: no exploration graph is running, so this tool has nothing to read or write. Start ARTEX mode before calling ARTEX tools.',
  isError: true,
};

export interface ArtexGraphHandle {
  readonly store: IArtexGraphStore;
  readonly explorationId: number;
}

export async function openActiveGraph(
  session: IArtexSessionContext,
  provider: IArtexGraphStoreProvider,
): Promise<ArtexGraphHandle | undefined> {
  const explorationId = session.getActiveExplorationId();
  if (explorationId === undefined) return undefined;
  const store = provider.open(session.workspaceRoot, explorationId);
  if (!(await store.isInitialized())) return undefined;
  return { store, explorationId };
}

export interface ArtexWorkHandle {
  readonly store: IArtexWorkStore;
  readonly taskId: number;
}

export async function openActiveWork(
  session: IArtexSessionContext,
  provider: IArtexWorkStoreProvider,
): Promise<ArtexWorkHandle | undefined> {
  const taskId = session.getActiveExplorationId();
  if (taskId === undefined) return undefined;
  const store = provider.open(session.workspaceRoot);
  await store.ensureSeeded();
  return { store, taskId };
}

export function artexJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function artexErr(message: string): ExecutableToolErrorResult {
  return { output: message, isError: true };
}
