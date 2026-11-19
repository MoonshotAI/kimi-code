import { watch } from 'vue';

export interface SessionExecutionState {
  turnId: string | null;
  status: 'running' | 'paused' | 'unknown' | 'idle';
  resolving?: boolean;
}

export interface SessionExecutionReadinessSources {
  read: () => SessionExecutionState;
  turnActive: () => boolean;
  timeoutMs: number;
}

export function isSessionExecutionReady(state: SessionExecutionState): boolean {
  return state.status === 'running' && state.turnId !== null;
}

export function isSessionExecutionSettled(
  state: SessionExecutionState,
  turnActive: boolean,
): boolean {
  if (isSessionExecutionReady(state)) return true;
  if (state.status === 'paused') return state.resolving !== true;
  return state.status !== 'unknown' && state.status !== 'running' && !turnActive;
}

export function waitForSessionExecution(
  sources: SessionExecutionReadinessSources,
): Promise<SessionExecutionState> {
  const initial = sources.read();
  if (isSessionExecutionSettled(initial, sources.turnActive())) return Promise.resolve(initial);
  return new Promise<SessionExecutionState>((resolve) => {
    let stop: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (state: SessionExecutionState): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      stop?.();
      resolve(state);
    };
    timer = setTimeout(() => {
      finish(sources.read());
    }, Math.max(sources.timeoutMs, 0));
    stop = watch(
      () => ({ state: sources.read(), turnActive: sources.turnActive() }),
      ({ state, turnActive }) => {
        if (isSessionExecutionSettled(state, turnActive)) finish(state);
      },
      { flush: 'sync' },
    );
    if (settled) stop();
  });
}
