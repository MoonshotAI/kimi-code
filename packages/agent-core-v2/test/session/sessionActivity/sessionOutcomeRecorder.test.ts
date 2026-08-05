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

describe('SessionOutcomeRecorder', () => {
  function harness(opts?: { withMain?: boolean }) {
    const withMain = opts?.withMain ?? true;
    const bus = new FakeBus();
    const mainHandle = {
      id: MAIN_AGENT_ID,
      accessor: { get: (token: unknown) => (token === IEventBus ? bus : undefined) },
    } as unknown as IAgentScopeHandle;
    const onDidCreate = new Emitter<IAgentScopeHandle>();
    let mainPresent = withMain;
    const agents = {
      get: (id: string) => (id === MAIN_AGENT_ID && mainPresent ? mainHandle : undefined),
      onDidCreate: onDidCreate.event,
    } as unknown as IAgentLifecycleService;
    const writes: SessionMeta['lastTurnOutcome'][] = [];
    const metadata = {
      update: async (patch: { lastTurnOutcome?: SessionMeta['lastTurnOutcome'] }) => {
        writes.push(patch.lastTurnOutcome);
      },
    } as unknown as ISessionMetadata;
    const recorder = new SessionOutcomeRecorder(agents, metadata);
    return {
      writes,
      ended: (reason: string, interruptReason?: string) =>
        bus.publish({ type: 'turn.ended', reason, interruptReason } as unknown as DomainEvent),
      arriveMain: () => {
        mainPresent = true;
        onDidCreate.fire(mainHandle);
      },
      dispose: () => {
        recorder.dispose();
      },
    };
  }

  it('persists completed and failed outcomes from the main agent', () => {
    const { writes, ended, dispose } = harness();
    ended('completed');
    ended('failed');
    ended('blocked'); // folds to 'failed', which the dedup then collapses
    expect(writes).toEqual(['completed', 'failed']);
    dispose();
  });

  it('persists a user stop but never a programmatic abort', () => {
    const { writes, ended, dispose } = harness();
    ended('cancelled', 'user_cancelled');
    ended('cancelled', 'aborted');
    ended('cancelled', undefined);
    expect(writes).toEqual(['cancelled']);
    dispose();
  });

  it('dedupes repeated outcomes within the process', () => {
    const { writes, ended, dispose } = harness();
    ended('failed');
    ended('failed');
    expect(writes).toEqual(['failed']);
    dispose();
  });

  it('subscribes when the main agent appears after construction', () => {
    const { writes, ended, arriveMain, dispose } = harness({ withMain: false });
    ended('failed');
    expect(writes).toEqual([]);
    arriveMain();
    ended('failed');
    expect(writes).toEqual(['failed']);
    dispose();
  });
});
