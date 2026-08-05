import { describe, expect, it } from 'vitest';

import { Emitter } from '#/_base/event';
import type { DomainEvent } from '#/app/event/eventBus';
import { IEventBus } from '#/app/event/eventBus';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { SessionOutcomeRecorder } from '#/session/sessionActivity/sessionOutcomeRecorderService';

class FakeBus {
  private readonly handlers = new Map<string, Array<(e: DomainEvent) => void>>();

  publish(event: DomainEvent): void {
    for (const h of this.handlers.get(event.type) ?? []) h(event);
  }

  subscribe(type: unknown, handler?: unknown) {
    const list = this.handlers.get(type as string) ?? [];
    const fn = handler as (e: DomainEvent) => void;
    list.push(fn);
    this.handlers.set(type as string, list);
    return { dispose: () => this.handlers.set(type as string, list.filter((h) => h !== fn)) };
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SessionOutcomeRecorder', () => {
  function harness(opts?: { persisted?: SessionMeta['lastTurnOutcome'] }) {
    const bus = new FakeBus();
    const mainHandle = {
      id: MAIN_AGENT_ID,
      accessor: { get: (token: unknown) => (token === IEventBus ? bus : undefined) },
    } as unknown as IAgentScopeHandle;
    const onDidCreate = new Emitter<IAgentScopeHandle>();
    let mainPresent = true;
    const agents = {
      get: (id: string) => (id === MAIN_AGENT_ID && mainPresent ? mainHandle : undefined),
      onDidCreate: onDidCreate.event,
    } as unknown as IAgentLifecycleService;
    const writes: (SessionMeta['lastTurnOutcome'])[] = [];
    let failNextWrite = false;
    const metadata = {
      read: async () => ({ lastTurnOutcome: opts?.persisted }) as SessionMeta,
      update: async (patch: { lastTurnOutcome?: SessionMeta['lastTurnOutcome'] }) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error('write failed');
        }
        writes.push(patch.lastTurnOutcome);
      },
    } as unknown as ISessionMetadata;
    const recorder = new SessionOutcomeRecorder(agents, metadata);
    return {
      writes,
      failNext: () => {
        failNextWrite = true;
      },
      started: () => bus.publish({ type: 'turn.started', turnId: 1 } as unknown as DomainEvent),
      ended: (reason: string, interruptReason?: string) =>
        bus.publish({ type: 'turn.ended', reason, interruptReason } as unknown as DomainEvent),
      arriveMain: () => {
        mainPresent = true;
        onDidCreate.fire(mainHandle);
      },
      hideMain: () => {
        mainPresent = false;
      },
      dispose: () => {
        recorder.dispose();
      },
    };
  }

  it('persists completed/failed/user-cancelled, never programmatic aborts', async () => {
    const { writes, ended, dispose } = harness();
    await tick();
    ended('completed');
    ended('failed');
    ended('blocked');
    ended('cancelled', 'user_cancelled');
    ended('cancelled', 'aborted');
    expect(writes).toEqual(['completed', 'failed', 'cancelled']);
    dispose();
  });

  it('dedupes against the durable value adopted at startup', async () => {
    const { writes, ended, dispose } = harness({ persisted: 'failed' });
    await tick();
    ended('failed');
    expect(writes).toEqual([]);
    ended('completed');
    expect(writes).toEqual(['completed']);
    dispose();
  });

  it('clears the stored outcome when a new turn starts', async () => {
    const { writes, started, dispose } = harness({ persisted: 'failed' });
    await tick();
    started();
    expect(writes).toEqual([undefined]);
    started();
    expect(writes).toEqual([undefined]);
    dispose();
  });

  it('retries the write when a persist fails', async () => {
    const { writes, failNext, ended, dispose } = harness();
    await tick();
    failNext();
    ended('failed');
    await tick();
    ended('failed');
    expect(writes).toEqual(['failed']);
    dispose();
  });
});
