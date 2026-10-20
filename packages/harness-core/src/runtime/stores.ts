import { useAgent, useApp, useSession } from '@moonshot-ai/agent-core/app/index';
import { computed, shallowRef, useCleanup, useFire, useReady, type ComputedRef, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import type { App } from '@moonshot-ai/agent-core/app/index';
import type { Agent, Session } from '@moonshot-ai/agent-core/session/index';
import type { Entry, Log, Projection } from '@moonshot-ai/agent-core/store/index';
import type { RuntimeEvent } from '@moonshot-ai/agent-core/kernel/index';

import { featureWriterOf, harnessInternals } from './harness';

export interface FeatureEvent extends RuntimeEvent {
  readonly turnId?: number;
}

export interface FeatureStore<S, E extends FeatureEvent> {
  readonly state: ComputedRef<S>;
  readonly ready: Promise<void>;
  dispatch(events: readonly E[]): Promise<void>;
  onCommit(listener: (entry: Entry<E>) => void): () => void;
}

function currentTurnId(agent: Agent): number | undefined {
  return agent.loop.state.turn?.id ?? agent.view.getState().turns.at(-1)?.turnId;
}

export function useFeatureStore<S, E extends FeatureEvent>(
  scope: 'agent' | 'session',
  name: string,
  projection: Projection<S, E>,
): FeatureStore<S, E> {
  const app = useApp();
  const session = useSession();
  const agent = scope === 'agent' ? useAgent() : undefined;
  const writer = featureWriterOf(harnessInternals(app), session.id);
  const logName = agent === undefined ? name : `agents/${agent.id}/${name}`;
  const fire = useFire();
  const state = shallowRef(projection.initial()) as ShallowRef<S>;
  let log: Log<E> | undefined;
  let disposeView: (() => void) | undefined;
  let disposed = false;
  const ready = (async () => {
    const opened = await writer.open<E>(logName);
    if (disposed) return;
    log = opened;
    const view = opened.replica.view(projection);
    disposeView = () => view.dispose();
    state.value = view.getState();
    view.subscribe((next) => {
      state.value = next;
    });
  })();
  useReady(ready);
  useCleanup(() => {
    disposed = true;
    disposeView?.();
  });
  return {
    state: computed(() => state.value),
    ready,
    dispatch: async (events) => {
      await ready;
      const opened = log;
      if (opened === undefined || disposed) throw new Error(`feature store '${logName}' is closed`);
      const turnId = agent === undefined ? undefined : currentTurnId(agent);
      const stamped = events.map((event) => (turnId === undefined ? event : { ...event, turnId }));
      await opened.commit({ events: stamped });
      if (disposed) return;
      for (const event of stamped) fire({ ...event });
    },
    onCommit: (listener) => {
      let off: () => void = () => {};
      let released = false;
      void ready.then(() => {
        if (released || log === undefined) return;
        void log
          .subscribe(log.version, (commit) => {
            for (const [index, event] of (commit.events ?? []).entries()) {
              listener({ seq: commit.seq + index, time: commit.time, event });
            }
          })
          .then((unsubscribe) => {
            if (released) unsubscribe();
            else off = unsubscribe;
          });
      });
      const release = (): void => {
        released = true;
        off();
      };
      useCleanup(release);
      return release;
    },
  };
}

export async function undoAgentTurns(app: App, session: Session, agentId: string, turns: number): Promise<void> {
  const agent = session.agents.get(agentId);
  if (agent === undefined) throw new Error(`agent '${agentId}' of session '${session.id}' is not open`);
  const cut = agent.view.getState().turns.at(-turns);
  if (cut === undefined) throw new Error(`cannot undo ${turns} turn(s): not enough turns`);
  await session.undo(agentId, turns);
  const writer = featureWriterOf(harnessInternals(app), session.id);
  for (const name of await writer.names(`agents/${agentId}/`)) {
    const log = await writer.open<FeatureEvent>(name);
    const first = log.replica
      .entries()
      .find((entry) => typeof entry.event.turnId === 'number' && entry.event.turnId >= cut.turnId);
    if (first !== undefined) await log.commit({ rewind: first.seq });
  }
}
