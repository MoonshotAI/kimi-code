import type { ExecutableToolErrorResult } from '#/tool/toolContract';

import type { IArtexGraphStore } from '#/features/artex/store/artexGraphStore';
import type { IArtexGraphStoreProvider } from '#/features/artex/store/artexGraphStoreProvider';
import type { IArtexWorkStore } from '#/features/artex/store/artexWorkStore';
import type { IArtexWorkStoreProvider } from '#/features/artex/store/artexWorkStoreProvider';
import type { IArtexSessionContext } from '#/features/artex/session/artexSessionContext';
import type { IArtexTrafficRecorder } from '#/features/artex/traffic/artexTrafficRecorder';

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

/**
 * Gates traffic tools on live recording. Returns an error result (never
 * undefined) when recording is off or unavailable, so the agent is told plainly
 * instead of receiving empty results that could read as "nothing was captured".
 */
export async function artexRecordingInactive(
  recorder: IArtexTrafficRecorder,
): Promise<ExecutableToolErrorResult | undefined> {
  const state = await recorder.ensureStarted();
  switch (state.status) {
    case 'recording':
      return undefined;
    case 'unavailable':
      return artexErr(
        `traffic recording is unavailable, so no traffic was captured to query: ${state.reason ?? 'unknown reason'}. This is reported rather than silently returning empty results.`,
      );
    case 'off':
      return artexErr(
        'traffic recording is not active in this session, so there is no captured traffic to query.',
      );
    default: {
      const exhaustive: never = state.status;
      return exhaustive;
    }
  }
}

export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [truncated, ${String(text.length)} bytes total; read the full body with traffic_blob] ...`;
}
