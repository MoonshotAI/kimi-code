/**
 * `SessionEventBroadcaster` — seq stamping, volatile vs durable, fan-out, replay.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IScopeHandle, Scope } from '@moonshot-ai/agent-core-v2';
import {
  ContextSizeModel,
  IAgentContextSizeService,
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentUsageService,
  IEventBus,
  IEventService,
  ISessionActivity,
  ISessionIndex,
  ISessionInteractionService,
  ISessionLifecycleService,
  IWireService,
  SessionInteractionService,
} from '@moonshot-ai/agent-core-v2';
import type { AgentEvent } from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type BroadcastTarget,
  SessionEventBroadcaster,
} from '../src/transport/ws/v1/sessionEventBroadcaster';
import {
  type EventEnvelope,
  SessionEventJournal,
} from '../src/transport/ws/v1/sessionEventJournal';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeAgentBus {
  private handlers: Array<(e: AgentEvent) => void> = [];
  disposeCount = 0;
  get subscriberCount(): number {
    return this.handlers.length;
  }
  subscribe(handler: (e: AgentEvent) => void) {
    this.handlers.push(handler);
    return {
      dispose: () => {
        this.disposeCount += 1;
        const i = this.handlers.indexOf(handler);
        if (i >= 0) this.handlers.splice(i, 1);
      },
    };
  }
  emit(e: AgentEvent): void {
    for (const h of [...this.handlers]) h(e);
  }
}

class FakeEventBus {
  private handlers: Array<(e: { type: string; payload: unknown }) => void> = [];
  subscribe(handler: (e: { type: string; payload: unknown }) => void) {
    this.handlers.push(handler);
    return {
      dispose: () => {
        const i = this.handlers.indexOf(handler);
        if (i >= 0) this.handlers.splice(i, 1);
      },
    };
  }
  emit(e: { type: string; payload: unknown }): void {
    for (const h of [...this.handlers]) h(e);
  }
}

class FakeAgentHandle {
  readonly kind = 2;
  readonly bus = new FakeAgentBus();
  readonly accessor;
  private readonly services = new Map<unknown, unknown>();
  failNextAccess = false;
  constructor(readonly id: string) {
    this.services.set(IEventBus, this.bus);
    this.accessor = {
      get: (token: unknown) => {
        if (this.failNextAccess) {
          this.failNextAccess = false;
          throw new Error('agent bus unavailable');
        }
        return this.services.get(token);
      },
    };
  }
  set(token: unknown, service: unknown): void {
    this.services.set(token, service);
  }
  dispose(): void {}
}

class FakeLifecycle {
  readonly handles: FakeAgentHandle[] = [];
  /** Real interaction kernel — served at the session accessor. */
  readonly interactions = new SessionInteractionService();
  baseStatus: 'idle' | 'running' = 'idle';
  onStatus: (() => void) | undefined;
  readonly activity = {
    status: () => {
      const onStatus = this.onStatus;
      this.onStatus = undefined;
      onStatus?.();
      if (this.interactions.listPending('approval').length > 0) return 'awaiting_approval';
      if (this.interactions.listPending('question').length > 0) return 'awaiting_question';
      return this.baseStatus;
    },
    isIdle: () => this.activity.status() === 'idle',
  };
  private createHandlers: Array<(h: IScopeHandle) => void> = [];
  private disposeHandlers: Array<(id: string) => void> = [];
  list(): readonly FakeAgentHandle[] {
    return this.handles;
  }
  getHandle(id: string): FakeAgentHandle | undefined {
    return this.handles.find((h) => h.id === id);
  }
  onDidCreate(h: (h: IScopeHandle) => void) {
    this.createHandlers.push(h);
    return {
      dispose: () => {
        const index = this.createHandlers.indexOf(h);
        if (index >= 0) this.createHandlers.splice(index, 1);
      },
    };
  }
  onDidDispose(h: (id: string) => void) {
    this.disposeHandlers.push(h);
    return {
      dispose: () => {
        const index = this.disposeHandlers.indexOf(h);
        if (index >= 0) this.disposeHandlers.splice(index, 1);
      },
    };
  }
  addAgent(id: string): FakeAgentHandle {
    const handle = new FakeAgentHandle(id);
    this.handles.push(handle);
    for (const cb of this.createHandlers) cb(handle as unknown as IScopeHandle);
    return handle;
  }
  removeAgent(id: string): void {
    const idx = this.handles.findIndex((h) => h.id === id);
    if (idx >= 0) this.handles.splice(idx, 1);
    for (const cb of this.disposeHandlers) cb(id);
  }
}

class FakeSessionLifecycleEvents {
  private readonly closeHandlers: Array<(event: { sessionId: string }) => void> = [];
  private readonly archiveHandlers: Array<(event: { sessionId: string }) => void> = [];
  failGet = false;

  readonly onDidCloseSession = (handler: (event: { sessionId: string }) => void) => {
    this.closeHandlers.push(handler);
    return {
      dispose: () => {
        const index = this.closeHandlers.indexOf(handler);
        if (index >= 0) this.closeHandlers.splice(index, 1);
      },
    };
  };

  readonly onDidArchiveSession = (handler: (event: { sessionId: string }) => void) => {
    this.archiveHandlers.push(handler);
    return {
      dispose: () => {
        const index = this.archiveHandlers.indexOf(handler);
        if (index >= 0) this.archiveHandlers.splice(index, 1);
      },
    };
  };

  close(sessionId: string): void {
    for (const handler of [...this.closeHandlers]) handler({ sessionId });
  }

  archive(sessionId: string): void {
    for (const handler of [...this.archiveHandlers]) handler({ sessionId });
  }
}

function makeCore(
  sessions: Map<string, FakeLifecycle>,
  eventBus = new FakeEventBus(),
  lifecycleEvents = new FakeSessionLifecycleEvents(),
): Scope {
  const scopeHandles = new Map<
    string,
    { lifecycle: FakeLifecycle; handle: IScopeHandle }
  >();
  const sessionLifecycle = {
    get: (sid: string) => {
      if (lifecycleEvents.failGet) throw new Error('InstantiationService has been disposed');
      const lifecycle = sessions.get(sid);
      if (lifecycle === undefined) {
        scopeHandles.delete(sid);
        return undefined;
      }
      const cached = scopeHandles.get(sid);
      if (cached?.lifecycle === lifecycle) return cached.handle;
      const sessionAccessor = {
        get: (t: unknown) => {
          if (t === IAgentLifecycleService) return lifecycle;
          if (t === ISessionActivity) return lifecycle.activity;
          if (t === ISessionInteractionService) return lifecycle.interactions;
          return undefined;
        },
      };
      const handle = {
        id: sid,
        kind: 1,
        accessor: sessionAccessor,
        dispose: () => {},
      } as unknown as IScopeHandle;
      scopeHandles.set(sid, { lifecycle, handle });
      return handle;
    },
    onDidCloseSession: lifecycleEvents.onDidCloseSession,
    onDidArchiveSession: lifecycleEvents.onDidArchiveSession,
  };
  const accessor = {
    get(token: unknown): unknown {
      if (token === IEventService) return eventBus;
      if (token === ISessionLifecycleService) return sessionLifecycle;
      if (token === ISessionIndex) return { get: async () => undefined };
      return undefined;
    },
  };
  return { accessor } as unknown as Scope;
}

function agentEvent(type: string, extra: Record<string, unknown> = {}): AgentEvent {
  return { type, ...extra } as unknown as AgentEvent;
}

function collectingTarget(): { target: BroadcastTarget; envelopes: EventEnvelope[] } {
  const envelopes: EventEnvelope[] = [];
  return { target: { send: (e) => envelopes.push(e) }, envelopes };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionEventBroadcaster', () => {
  let dir: string;
  let sessions: Map<string, FakeLifecycle>;
  let eventBus: FakeEventBus;
  let lifecycleEvents: FakeSessionLifecycleEvents;
  let bc: SessionEventBroadcaster;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-broadcaster-test-'));
    sessions = new Map();
    eventBus = new FakeEventBus();
    lifecycleEvents = new FakeSessionLifecycleEvents();
    bc = new SessionEventBroadcaster({
      eventsDir: dir,
      core: makeCore(sessions, eventBus, lifecycleEvents),
      maxBufferSize: 3,
    });
  });

  afterEach(async () => {
    await bc.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('stamps monotonic seq on durable events and fans out', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);

    const { target, envelopes } = collectingTarget();
    expect(await bc.subscribe('s1', target)).toBe(true);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
    await bc.getCursor('s1'); // drain

    // `turn.started` emits a durable `event.session.status_changed(running)`
    // ahead of it and `turn.ended` emits a durable
    // `event.session.status_changed(idle)` after it, hence four durable events:
    // status_changed, turn.started, turn.ended, status_changed.
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(envelopes.every((e) => e.epoch === envelopes[0]!.epoch)).toBe(true);
    expect(envelopes[0]!.volatile).toBeUndefined();
  });

  it('shares one owner when concurrent subscribers first activate a session', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const first = collectingTarget();
    const second = collectingTarget();

    expect(
      await Promise.all([bc.subscribe('s1', first.target), bc.subscribe('s1', second.target)]),
    ).toEqual([true, true]);
    expect(main.bus.subscriberCount).toBe(1);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    expect((await bc.getCursor('s1')).seq).toBe(2);
    expect(first.envelopes.map((envelope) => envelope.type)).toEqual([
      'event.session.status_changed',
      'turn.started',
    ]);
    expect(second.envelopes.map((envelope) => envelope.type)).toEqual([
      'event.session.status_changed',
      'turn.started',
    ]);
  });

  it('allows activation to retry after a shared concurrent initialization fails', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    main.failNextAccess = true;
    sessions.set('s1', lc);

    const failed = await Promise.allSettled([
      bc.subscribe('s1', collectingTarget().target),
      bc.subscribe('s1', collectingTarget().target),
    ]);
    expect(
      failed.map((result) =>
        result.status === 'rejected' ? (result.reason as Error).message : result.status,
      ),
    ).toEqual(['agent bus unavailable', 'agent bus unavailable']);
    expect(main.bus.subscriberCount).toBe(0);

    await expect(bc.subscribe('s1', collectingTarget().target)).resolves.toBe(true);
    expect(main.bus.subscriberCount).toBe(1);
  });

  it('releases partial agent subscriptions when activation fails before publish', async () => {
    const lc = new FakeLifecycle();
    const first = lc.addAgent('agent-a');
    const second = lc.addAgent('agent-b');
    second.failNextAccess = true;
    sessions.set('s1', lc);

    await expect(bc.subscribe('s1', collectingTarget().target)).rejects.toThrow(
      'agent bus unavailable',
    );
    expect([first.bus.subscriberCount, second.bus.subscriberCount]).toEqual([0, 0]);

    await expect(bc.subscribe('s1', collectingTarget().target)).resolves.toBe(true);
    expect([first.bus.subscriberCount, second.bus.subscriberCount]).toEqual([1, 1]);
  });

  it('retires an initializing owner once when close and archive fire together', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    lc.onStatus = () => {
      sessions.delete('s1');
      lifecycleEvents.close('s1');
      lifecycleEvents.archive('s1');
    };
    const closeJournal = vi.spyOn(SessionEventJournal.prototype, 'close');

    try {
      await expect(bc.subscribe('s1', collectingTarget().target)).resolves.toBe(false);
      expect(main.bus.subscriberCount).toBe(0);
      expect(main.bus.disposeCount).toBe(1);
      expect(closeJournal).toHaveBeenCalledTimes(1);
    } finally {
      closeJournal.mockRestore();
    }
  });

  it.each(['close', 'archive'] as const)(
    'returns cold results when lifecycle %s happens during journal activation',
    async (transition) => {
      const lc = new FakeLifecycle();
      const main = lc.addAgent('main');
      sessions.set('s1', lc);
      const originalOpen = SessionEventJournal.open;
      let signalOpenStarted!: () => void;
      let releaseOpen!: () => void;
      const openStarted = new Promise<void>((resolve) => {
        signalOpenStarted = resolve;
      });
      const openGate = new Promise<void>((resolve) => {
        releaseOpen = resolve;
      });
      const openJournal = vi
        .spyOn(SessionEventJournal, 'open')
        .mockImplementation(async (filePath, logger) => {
          if (filePath.endsWith('s1.jsonl')) {
            signalOpenStarted();
            await openGate;
          }
          return originalOpen(filePath, logger);
        });
      let subscribing: Promise<boolean> | undefined;

      try {
        subscribing = bc.subscribe('s1', collectingTarget().target);
        await openStarted;
        sessions.delete('s1');
        lifecycleEvents[transition]('s1');
        releaseOpen();

        await expect(subscribing).resolves.toBe(false);
        expect(main.bus.subscriberCount).toBe(0);
        await expect(bc.getCursor('s1')).resolves.toEqual({ seq: 0, epoch: '' });
        await expect(bc.getSnapshotState('s1')).resolves.toEqual({
          seq: 0,
          epoch: '',
          inFlightTurn: null,
          subagents: [],
        });
      } finally {
        releaseOpen();
        if (subscribing !== undefined) await Promise.allSettled([subscribing]);
        openJournal.mockRestore();
      }
    },
  );

  it.each(['close', 'archive'] as const)(
    'moves ownership to a fresh session after lifecycle %s',
    async (transition) => {
      const firstLifecycle = new FakeLifecycle();
      const firstMain = firstLifecycle.addAgent('main');
      sessions.set('s1', firstLifecycle);
      await bc.subscribe('s1', collectingTarget().target);
      expect(firstMain.bus.subscriberCount).toBe(1);

      sessions.delete('s1');
      lifecycleEvents[transition]('s1');
      expect(firstMain.bus.subscriberCount).toBe(0);

      const secondLifecycle = new FakeLifecycle();
      const secondMain = secondLifecycle.addAgent('main');
      sessions.set('s1', secondLifecycle);
      const secondView = collectingTarget();
      await bc.subscribe('s1', secondView.target);
      expect(secondMain.bus.subscriberCount).toBe(1);

      secondMain.bus.emit(agentEvent('turn.started', { turnId: 1 }));
      await bc.getCursor('s1');
      expect(secondView.envelopes.map((envelope) => envelope.type)).toEqual([
        'event.session.status_changed',
        'turn.started',
      ]);
    },
  );

  it('delivers durable events already queued when lifecycle close retires the owner', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const view = collectingTarget();
    await bc.subscribe('s1', view.target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    sessions.delete('s1');
    lifecycleEvents.close('s1');
    await expect(bc.subscribe('s1', collectingTarget().target)).resolves.toBe(false);

    expect(view.envelopes.map((envelope) => envelope.type)).toEqual([
      'event.session.status_changed',
      'turn.started',
    ]);
  });

  it('returns false when subscribe waits on retirement during broadcaster close', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    await bc.subscribe('s1', collectingTarget().target);
    const originalClose = SessionEventJournal.prototype.close;
    let signalCloseStarted!: () => void;
    let releaseClose!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      signalCloseStarted = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closeJournal = vi
      .spyOn(SessionEventJournal.prototype, 'close')
      .mockImplementation(async function (this: SessionEventJournal) {
        signalCloseStarted();
        await closeGate;
        return originalClose.call(this);
      });
    let subscribing: Promise<boolean> | undefined;
    let closing: Promise<void> | undefined;

    try {
      sessions.delete('s1');
      lifecycleEvents.close('s1');
      await closeStarted;
      subscribing = bc.subscribe('s1', collectingTarget().target);
      closing = bc.close();
      lifecycleEvents.failGet = true;
      releaseClose();

      await expect(subscribing).resolves.toBe(false);
      await closing;
      expect(closeJournal).toHaveBeenCalledTimes(1);
    } finally {
      lifecycleEvents.failGet = false;
      releaseClose();
      await Promise.allSettled([subscribing, closing].filter((value) => value !== undefined));
      closeJournal.mockRestore();
    }
  });

  it('does not append a core session event after lifecycle release wins the enqueue race', async () => {
    const firstLifecycle = new FakeLifecycle();
    const firstMain = firstLifecycle.addAgent('main');
    sessions.set('s1', firstLifecycle);
    const firstView = collectingTarget();
    await bc.subscribe('s1', firstView.target);
    firstMain.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    const beforeRelease = await bc.getCursor('s1');

    eventBus.emit({
      type: 'session.meta.updated',
      payload: { sessionId: 's1', title: 'stale' },
    });
    sessions.delete('s1');
    lifecycleEvents.close('s1');
    await expect(bc.subscribe('s1', collectingTarget().target)).resolves.toBe(false);
    expect(firstView.envelopes.map((envelope) => envelope.type)).not.toContain(
      'session.meta.updated',
    );

    const secondLifecycle = new FakeLifecycle();
    const secondMain = secondLifecycle.addAgent('main');
    sessions.set('s1', secondLifecycle);
    await bc.subscribe('s1', collectingTarget().target);
    await expect(bc.getCursor('s1')).resolves.toEqual(beforeRelease);
    secondMain.bus.emit(agentEvent('turn.ended', { turnId: 2 }));
    expect((await bc.getCursor('s1')).seq).toBe(beforeRelease.seq + 1);
    const replay = await bc.getBufferedSince('s1', beforeRelease);
    expect(replay.events.map(({ envelope }) => envelope.type)).toEqual(['turn.ended']);
  });

  it('returns session-owned subscriptions to baseline across a 3 by 8 lifecycle soak', async () => {
    const sessionIds = Array.from({ length: 8 }, (_, index) => `soak-${index}`);
    const allLifecycles: FakeLifecycle[] = [];
    const resourceSamples: Array<{
      round: number;
      activeOwners: number;
      heapUsed: number;
      rss: number;
    }> = [];

    for (let round = 1; round <= 3; round += 1) {
      const lifecycles = sessionIds.map(() => {
        const lifecycle = new FakeLifecycle();
        lifecycle.addAgent('main');
        return lifecycle;
      });
      allLifecycles.push(...lifecycles);
      for (const [index, sessionId] of sessionIds.entries()) {
        sessions.set(sessionId, lifecycles[index]!);
        expect(await bc.subscribe(sessionId, collectingTarget().target)).toBe(true);
      }
      expect(
        lifecycles.reduce(
          (total, lifecycle) => total + lifecycle.handles[0]!.bus.subscriberCount,
          0,
        ),
      ).toBe(8);

      for (const [index, sessionId] of sessionIds.entries()) {
        sessions.delete(sessionId);
        if (index % 2 === 0) lifecycleEvents.close(sessionId);
        else lifecycleEvents.archive(sessionId);
      }
      for (const sessionId of sessionIds) {
        expect(await bc.subscribe(sessionId, collectingTarget().target)).toBe(false);
      }
      const activeOwners = allLifecycles.reduce(
        (total, lifecycle) => total + lifecycle.handles[0]!.bus.subscriberCount,
        0,
      );
      const memory = process.memoryUsage();
      resourceSamples.push({ round, activeOwners, heapUsed: memory.heapUsed, rss: memory.rss });
      expect(activeOwners).toBe(0);
    }

    console.info('SessionEventBroadcaster 3x8 resource samples', resourceSamples);
    expect(resourceSamples.map((sample) => sample.activeOwners)).toEqual([0, 0, 0]);
  });

  it('fans out volatile events with the current watermark + offset, not journaled', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 })); // durable seq 1
    main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'Hi' })); // volatile
    main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: ' there' })); // volatile
    await bc.getCursor('s1');

    const vol = envelopes.filter((e) => e.volatile === true);
    expect(vol).toHaveLength(2);
    // `turn.started` is now seq 2 (a durable status_changed takes seq 1), so
    // the volatile deltas ride the watermark at 2.
    expect(vol.every((e) => e.seq === 2)).toBe(true); // rides the durable watermark
    expect(vol.map((e) => e.offset)).toEqual([0, 2]);
    expect((await bc.getCursor('s1')).seq).toBe(2); // seq did not advance
  });

  it('projects main-agent status and context changes into complete v1 status events', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    let contextSize = 10;
    const usage = {
      total: { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
    };
    main.set(IAgentContextSizeService, { get: () => ({ size: contextSize }) });
    main.set(IAgentProfileService, {
      getModel: () => 'example-model',
      getModelCapabilities: () => ({ max_context_tokens: 128_000 }),
    });
    main.set(IAgentUsageService, { status: () => usage });
    main.set(IWireService, {
      getModel: (model: unknown) => {
        expect(model).toBe(ContextSizeModel);
        return { length: 0, tokens: 8 };
      },
    });
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('agent.status.updated', { usage }));
    contextSize = 20;
    main.bus.emit(agentEvent('context.spliced', { start: 0, deleteCount: 0, messages: [] }));
    main.bus.emit(agentEvent('context.spliced', { start: 0, deleteCount: 0, messages: [] }));
    await bc.getCursor('s1');

    const statuses = envelopes.filter((envelope) => envelope.type === 'agent.status.updated');
    expect(statuses).toHaveLength(2);
    expect(statuses.map((envelope) => envelope.payload)).toMatchObject([
      {
        type: 'agent.status.updated',
        usage,
        contextTokens: 10,
        maxContextTokens: 128_000,
        model: 'example-model',
      },
      {
        type: 'agent.status.updated',
        usage,
        contextTokens: 20,
        maxContextTokens: 128_000,
        model: 'example-model',
      },
    ]);
  });

  it('projects agent activity state into legacy running and ended phases', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(
      agentEvent('agent.activity.updated', {
        lifecycle: 'ready',
        turn: {
          turnId: 1,
          origin: { kind: 'user' },
          phase: 'running',
          step: 1,
          ending: false,
          pendingApprovals: [],
          activeToolCalls: [],
          since: 100,
        },
        background: [],
      }),
    );
    main.bus.emit(
      agentEvent('agent.activity.updated', {
        lifecycle: 'ready',
        lastTurn: { turnId: 1, reason: 'completed', at: 200 },
        background: [],
      }),
    );
    await bc.getCursor('s1');

    const statuses = envelopes.filter((envelope) => envelope.type === 'agent.status.updated');
    expect(statuses.map((envelope) => envelope.payload)).toMatchObject([
      { phase: { kind: 'running', turnId: 1, step: 1 } },
      { phase: { kind: 'ended', turnId: 1, reason: 'completed' } },
    ]);
  });

  it('replays durable events since a cursor from the journal', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
    await bc.getCursor('s1');

    const result = await bc.getBufferedSince('s1', { seq: 1 });
    expect(result.resyncRequired).toBe(false);
    // seq 1 is the durable status_changed(running) (emitted ahead of
    // turn.started); events after it are turn.started (2), turn.ended (3) and
    // the durable status_changed(idle) (4) emitted on turn end.
    expect(result.events.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(result.currentSeq).toBe(4);
  });

  it('returns buffer_overflow when the gap exceeds the cap', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target } = collectingTarget();
    await bc.subscribe('s1', target);

    for (let i = 0; i < 5; i++) main.bus.emit(agentEvent('turn.started', { turnId: i }));
    await bc.getCursor('s1'); // seq = 6 (one deduplicated running status + five turns), maxBufferSize = 3

    const result = await bc.getBufferedSince('s1', { seq: 0 });
    expect(result.resyncRequired).toBe('buffer_overflow');
    expect(result.currentSeq).toBe(6);
  });

  it('returns epoch_changed for a mismatched epoch', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target } = collectingTarget();
    await bc.subscribe('s1', target);

    const result = await bc.getBufferedSince('s1', { seq: 0, epoch: 'ep_wrong' });
    expect(result.resyncRequired).toBe('epoch_changed');
  });

  it('subscribes to agents created after activation (onDidCreate)', async () => {
    const lc = new FakeLifecycle();
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    const late = lc.addAgent('main'); // created after subscribe
    late.bus.emit(agentEvent('turn.started', { turnId: 7 }));
    await bc.getCursor('s1');

    // status_changed (seq 1) is emitted ahead of turn.started (seq 2).
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('getSnapshotState returns the in-flight turn', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    await bc.subscribe('s1', collectingTarget().target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(agentEvent('assistant.delta', { turnId: 1, delta: 'Hello' }));
    const snap = await bc.getSnapshotState('s1');

    expect(snap.seq).toBe(2); // durable status_changed + turn.started advanced seq; the delta is volatile
    expect(snap.inFlightTurn).toMatchObject({ turn_id: 1, assistant_text: 'Hello' });
  });

  it('getSnapshotState returns the live subagent roster until the next main turn starts', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    const sub = lc.addAgent('agent-1');
    sessions.set('s1', lc);
    await bc.subscribe('s1', collectingTarget().target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(
      agentEvent('subagent.spawned', {
        subagentId: 'agent-1',
        subagentName: 'kimi-subagent',
        parentToolCallId: 'tc_swarm_1',
        description: 'task agent-1',
        swarmIndex: 0,
        runInBackground: false,
      }),
    );
    main.bus.emit(agentEvent('subagent.started', { subagentId: 'agent-1' }));

    const mid = await bc.getSnapshotState('s1');
    expect(mid.subagents).toEqual([
      expect.objectContaining({
        id: 'agent-1',
        kind: 'subagent',
        description: 'task agent-1',
        subagent_phase: 'working',
        parent_tool_call_id: 'tc_swarm_1',
        swarm_index: 0,
        run_in_background: false,
      }),
    ]);

    // A subagent's own turn.ended must not wipe the roster mid-swarm.
    sub.bus.emit(agentEvent('turn.ended', { turnId: 2 }));
    const still = await bc.getSnapshotState('s1');
    expect(still.subagents).toHaveLength(1);

    // The main turn.ended keeps the roster too: the swarm result may not be
    // durable in the wire transcript yet (async append).
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    const ended = await bc.getSnapshotState('s1');
    expect(ended.subagents).toHaveLength(1);

    // The next main turn.started settles the transcript — the roster is dropped.
    main.bus.emit(agentEvent('turn.started', { turnId: 2 }));
    const next = await bc.getSnapshotState('s1');
    expect(next.subagents).toEqual([]);
  });

  it('fans core model-catalog changes out to every session subscriber', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    eventBus.emit({
      type: 'event.model_catalog.changed',
      payload: {
        changed: [{ provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 1, removed: 0 }],
        unchanged: [],
        failed: [],
      },
    });

    await vi.waitFor(() => expect(envelopes).toHaveLength(1));
    expect(envelopes[0]).toMatchObject({
      type: 'event.model_catalog.changed',
      seq: 1,
      session_id: '__global__',
      payload: {
        type: 'event.model_catalog.changed',
        agentId: 'main',
        sessionId: '__global__',
      },
    });
  });

  it('shares one global journal owner when concurrent core events first activate it', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);
    const openJournal = vi.spyOn(SessionEventJournal, 'open');

    try {
      const event = {
        type: 'event.model_catalog.changed',
        payload: {
          changed: [{ provider_id: 'provider:test', provider_name: 'Example', added: 1, removed: 0 }],
          unchanged: [],
          failed: [],
        },
      };
      eventBus.emit(event);
      eventBus.emit(event);

      await vi.waitFor(() => {
        expect(envelopes).toHaveLength(2);
      });
      expect(openJournal).toHaveBeenCalledTimes(1);
      expect(envelopes.map((envelope) => envelope.seq)).toEqual([1, 2]);
    } finally {
      openJournal.mockRestore();
    }
  });

  it('shares the in-flight global activation barrier across concurrent close calls', async () => {
    const originalOpen = SessionEventJournal.open;
    let signalOpenStarted!: () => void;
    let releaseOpen!: () => void;
    const openStarted = new Promise<void>((resolve) => {
      signalOpenStarted = resolve;
    });
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const openJournal = vi
      .spyOn(SessionEventJournal, 'open')
      .mockImplementation(async (filePath, logger) => {
        if (filePath.endsWith('__global__.jsonl')) {
          signalOpenStarted();
          await openGate;
        }
        return originalOpen(filePath, logger);
      });
    let closing: Promise<void> | undefined;
    let observedClosing: Promise<void> | undefined;

    try {
      eventBus.emit({
        type: 'event.model_catalog.changed',
        payload: { changed: [], unchanged: [], failed: [] },
      });
      await openStarted;
      let closeSettled = false;
      closing = bc.close();
      const duplicateClosing = bc.close();
      expect(duplicateClosing).toBe(closing);
      observedClosing = duplicateClosing.then(() => {
        closeSettled = true;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(closeSettled).toBe(false);

      releaseOpen();
      await observedClosing;
      eventBus.emit({
        type: 'event.model_catalog.changed',
        payload: { changed: [], unchanged: [], failed: [] },
      });
      await Promise.resolve();
      expect(openJournal).toHaveBeenCalledTimes(1);
    } finally {
      releaseOpen();
      await Promise.allSettled(
        [closing, observedClosing].filter((value) => value !== undefined),
      );
      openJournal.mockRestore();
    }
  });

  it('subscribe returns false for an unknown session', async () => {
    const { target } = collectingTarget();
    expect(await bc.subscribe('nope', target)).toBe(false);
  });

  it('broadcasts session.meta.updated under the real session id and fans out to every connection', async () => {
    // Regression: a new session's first prompt auto-generates a title and the
    // daemon announces it via `session.meta.updated`. The event must be
    // addressed to the real session so clients can match it to a sidebar row;
    // stamping `session_id = '__global__'` left the row title stuck empty.
    // (No agents attached — `session.meta.updated` is a core event, not an
    // agent event, so the agent subscription path is irrelevant here.)
    sessions.set('s1', new FakeLifecycle());

    // A second, unrelated session with its own subscriber proves the meta
    // update still fans out globally (clients not subscribed to s1 learn the
    // new title too), even though the envelope is addressed to s1.
    sessions.set('s2', new FakeLifecycle());

    const s1View = collectingTarget();
    const s2View = collectingTarget();
    await bc.subscribe('s1', s1View.target);
    await bc.subscribe('s2', s2View.target);

    eventBus.emit({
      type: 'session.meta.updated',
      payload: {
        agentId: 'main',
        sessionId: 's1',
        title: '测试',
        patch: { title: '测试', isCustomTitle: false, lastPrompt: '测试' },
      },
    });

    await vi.waitFor(() => expect(s1View.envelopes).toHaveLength(1));
    await vi.waitFor(() => expect(s2View.envelopes).toHaveLength(1));

    expect(s1View.envelopes[0]).toMatchObject({
      type: 'session.meta.updated',
      session_id: 's1',
      payload: {
        type: 'session.meta.updated',
        agentId: 'main',
        sessionId: 's1',
        title: '测试',
        patch: { title: '测试', lastPrompt: '测试' },
      },
    });
    expect(s1View.envelopes[0]!.session_id).not.toBe('__global__');
    // Fanned out to the non-subscriber under the same real session id.
    expect(s2View.envelopes[0]!.session_id).toBe('s1');
    expect(s1View.envelopes[0]!.volatile).toBeUndefined();
  });

  it('broadcasts event.session.created under the real session id and fans out to every connection', async () => {
    // Regression: v2 publishes `event.session.created` on the core bus but the
    // broadcaster did not forward it, so clients that didn't issue the create
    // never learned the session exists. Without it, a later sessionStatusChanged
    // reducer is a no-op for the unknown session and kimi-web's Stop button
    // (gated on session.status === 'running') never renders.
    sessions.set('s1', new FakeLifecycle());
    sessions.set('s2', new FakeLifecycle());

    const s1View = collectingTarget();
    const s2View = collectingTarget();
    await bc.subscribe('s1', s1View.target);
    await bc.subscribe('s2', s2View.target);

    const session = { id: 's1', title: 't', status: 'idle' };
    eventBus.emit({
      type: 'event.session.created',
      payload: { agentId: 'main', sessionId: 's1', session },
    });

    await vi.waitFor(() => expect(s1View.envelopes).toHaveLength(1));
    await vi.waitFor(() => expect(s2View.envelopes).toHaveLength(1));

    expect(s1View.envelopes[0]).toMatchObject({
      type: 'event.session.created',
      session_id: 's1',
      payload: {
        type: 'event.session.created',
        agentId: 'main',
        sessionId: 's1',
        session,
      },
    });
    expect(s1View.envelopes[0]!.session_id).not.toBe('__global__');
    // Fanned out to the non-subscriber under the same real session id.
    expect(s2View.envelopes[0]!.session_id).toBe('s1');
    expect(s1View.envelopes[0]!.volatile).toBeUndefined();
  });

  it('emits a durable event.session.status_changed(running) ahead of turn.started', async () => {
    // Regression: v2 derives the session status via ISessionActivity (a pure
    // pull) and publishes nothing, so the WS stream never carried the running
    // transition and kimi-web's Stop button never rendered. The broadcaster
    // now re-emits the authoritative running status on turn.started, ahead of
    // the turn event so the web projector's prompt_id binding applies after.
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    await bc.getCursor('s1');

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toMatchObject({
      type: 'event.session.status_changed',
      seq: 1,
      session_id: 's1',
      payload: {
        type: 'event.session.status_changed',
        status: 'running',
        previous_status: 'idle',
        agentId: 'main',
        sessionId: 's1',
      },
    });
    expect(envelopes[0]!.volatile).toBeUndefined();
    expect(envelopes[1]).toMatchObject({ type: 'turn.started', seq: 2 });
  });

  it('emits a durable event.session.status_changed(idle) after turn.ended', async () => {
    // Regression: v2 derives session status via ISessionActivity (a pure pull)
    // and publishes nothing, and kimi-web's turn.ended projector deliberately
    // does NOT synthesize a status flip — the daemon's
    // `event.session.status_changed` is its only turn-end signal (it drives
    // onSessionIdle queue flush and clears the Stop/loading state). Without
    // this the session stayed `running` forever once a turn ended; most
    // visibly for background tasks, where ISessionActivity keeps reporting
    // non-idle while the detached task lives, so even a REST pull never
    // corrected it. Emitted after turn.ended (same queue) so the web finishes
    // the assistant message before flipping status.
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    await bc.getCursor('s1');

    expect(envelopes).toHaveLength(4);
    expect(envelopes[2]).toMatchObject({ type: 'turn.ended', seq: 3 });
    expect(envelopes[3]).toMatchObject({
      type: 'event.session.status_changed',
      seq: 4,
      session_id: 's1',
      payload: {
        type: 'event.session.status_changed',
        status: 'idle',
        previous_status: 'running',
        agentId: 'main',
        sessionId: 's1',
      },
    });
    expect(envelopes[3]!.volatile).toBeUndefined();
  });

  it('emits event.session.status_changed(aborted) when a turn ends cancelled/failed/blocked', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'cancelled' }));
    await bc.getCursor('s1');

    const statuses = envelopes.filter((e) => e.type === 'event.session.status_changed');
    expect(statuses.map((e) => e.payload)).toMatchObject([
      { status: 'running', previous_status: 'idle' },
      { status: 'aborted', previous_status: 'running' },
    ]);
  });

  it('does not synthesize session status from sub-agent turn boundaries', async () => {
    // Regression: a sub-agent's turn.started/turn.ended stream over the same
    // session channel with their own agentId. Synthesizing status transitions
    // from them emitted a bogus `status_changed(idle)` the moment a foreground
    // sub-agent finished — mid main turn — which kimi-web reads as "the turn
    // finished" (browser notification, completion sound, unread dot, queued
    // message drain), while the real main-agent turn end was then swallowed by
    // dedup and never notified.
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    const sub = lc.addAgent('agent-0');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    // A foreground sub-agent runs and completes while the main turn is in flight.
    sub.bus.emit(agentEvent('turn.started', { turnId: 10 }));
    sub.bus.emit(agentEvent('turn.ended', { turnId: 10, reason: 'completed' }));
    main.bus.emit(agentEvent('turn.ended', { turnId: 1, reason: 'completed' }));
    await bc.getCursor('s1');

    // The sub-agent's turn events are still fanned out (clients render them in
    // the task view), but they produce no status transitions.
    expect(
      envelopes
        .filter((e) => e.type === 'turn.started' || e.type === 'turn.ended')
        .map((e) => (e.payload as { agentId: string }).agentId),
    ).toEqual(['main', 'agent-0', 'agent-0', 'main']);
    const statusEnvs = envelopes.filter((e) => e.type === 'event.session.status_changed');
    expect(statusEnvs.map((e) => e.payload)).toMatchObject([
      { status: 'running', previous_status: 'idle' },
      { status: 'idle', previous_status: 'running' },
    ]);
    // The idle transition fires exactly once, after the main agent's turn end.
    expect(envelopes.at(-1)!.type).toBe('event.session.status_changed');
  });

  it('broadcasts question requested / answered as durable v1 events', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    lc.interactions.enqueue({
      id: 'q1',
      kind: 'question',
      payload: {
        toolCallId: 'call_1',
        questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
      },
    });
    await bc.getCursor('s1');

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toMatchObject({
      type: 'event.question.requested',
      seq: 1,
      session_id: 's1',
      payload: {
        type: 'event.question.requested',
        agentId: 'main',
        sessionId: 's1',
        question_id: 'q1',
        session_id: 's1',
        tool_call_id: 'call_1',
        questions: [{ id: 'q_0', question: 'Pick one', options: [{ id: 'opt_0_0', label: 'A' }, { id: 'opt_0_1', label: 'B' }] }],
      },
    });
    expect(envelopes[1]).toMatchObject({
      type: 'event.session.status_changed',
      payload: { status: 'awaiting_question', previous_status: 'idle' },
    });
    expect(envelopes[0]!.volatile).toBeUndefined();

    lc.interactions.respond('q1', { answers: { q_0: 'opt_0_0' }, method: 'enter' });
    await bc.getCursor('s1');

    expect(envelopes).toHaveLength(4);
    expect(envelopes[2]).toMatchObject({
      type: 'event.question.answered',
      seq: 3,
      session_id: 's1',
      payload: {
        question_id: 'q1',
        answers: { q_0: 'opt_0_0' },
      },
    });
    expect((envelopes[2]!.payload as { resolved_at?: string }).resolved_at).toBeTypeOf('string');
    expect(envelopes[3]).toMatchObject({
      type: 'event.session.status_changed',
      payload: { status: 'idle', previous_status: 'awaiting_question' },
    });
  });

  it('broadcasts question dismissed when resolved with null', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    lc.interactions.enqueue({
      id: 'q1',
      kind: 'question',
      payload: { questions: [{ question: 'Pick', options: [{ label: 'A' }] }] },
    });
    lc.interactions.respond('q1', null); // = ISessionQuestionService.dismiss
    await bc.getCursor('s1');

    expect(envelopes.map((e) => e.type)).toEqual([
      'event.question.requested',
      'event.session.status_changed',
      'event.question.dismissed',
      'event.session.status_changed',
    ]);
    expect(envelopes[2]!.payload).toMatchObject({ question_id: 'q1' });
    expect((envelopes[2]!.payload as { dismissed_at?: string }).dismissed_at).toBeTypeOf('string');
  });

  it('broadcasts approval requested / resolved as durable v1 events', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    lc.interactions.enqueue({
      id: 'a1',
      kind: 'approval',
      payload: {
        toolCallId: 'call_9',
        toolName: 'Bash',
        action: 'run',
        display: { kind: 'command', command: 'ls' },
      },
      origin: { turnId: 3 },
    });
    await bc.getCursor('s1');

    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toMatchObject({
      type: 'event.approval.requested',
      seq: 1,
      session_id: 's1',
      payload: {
        approval_id: 'a1',
        session_id: 's1',
        turn_id: 3,
        tool_call_id: 'call_9',
        tool_name: 'Bash',
        action: 'run',
        tool_input_display: { kind: 'command', command: 'ls' },
      },
    });
    expect(envelopes[1]).toMatchObject({
      type: 'event.session.status_changed',
      payload: { status: 'awaiting_approval', previous_status: 'idle' },
    });

    lc.interactions.respond('a1', { decision: 'approved', scope: 'session' });
    await bc.getCursor('s1');

    expect(envelopes).toHaveLength(4);
    expect(envelopes[2]).toMatchObject({
      type: 'event.approval.resolved',
      seq: 3,
      session_id: 's1',
      payload: {
        approval_id: 'a1',
        decision: 'approved',
        scope: 'session',
      },
    });
    expect((envelopes[2]!.payload as { resolved_at?: string }).resolved_at).toBeTypeOf('string');
    expect(envelopes[3]).toMatchObject({
      type: 'event.session.status_changed',
      payload: { status: 'idle', previous_status: 'awaiting_approval' },
    });
  });

  it('keeps parallel interaction priority, dedupes status, and globally fans status out', async () => {
    const lc = new FakeLifecycle();
    lc.baseStatus = 'running';
    lc.addAgent('main');
    sessions.set('s1', lc);
    sessions.set('s2', new FakeLifecycle());

    const s1View = collectingTarget();
    const s2View = collectingTarget();
    await bc.subscribe('s1', s1View.target);
    await bc.subscribe('s2', s2View.target);

    lc.interactions.enqueue({
      id: 'q1',
      kind: 'question',
      payload: { questions: [{ question: 'Pick', options: [{ label: 'A' }] }] },
    });
    lc.interactions.enqueue({
      id: 'a1',
      kind: 'approval',
      payload: { toolName: 'Bash', action: 'run' },
    });
    lc.interactions.respond('q1', { answers: { q_0: 'opt_0_0' } });
    await bc.getCursor('s1');

    expect(
      s1View.envelopes
        .filter((e) => e.type === 'event.session.status_changed')
        .map((e) => e.payload),
    ).toMatchObject([
      { status: 'awaiting_question', previous_status: 'running' },
      { status: 'awaiting_approval', previous_status: 'awaiting_question' },
    ]);
    // Resolving the question does not restore running while approval remains.
    expect(s1View.envelopes.at(-1)!.type).toBe('event.question.answered');
    expect(s2View.envelopes.map((e) => e.type)).toEqual([
      'event.session.status_changed',
      'event.session.status_changed',
    ]);

    lc.interactions.respond('a1', { decision: 'approved' });
    await bc.getCursor('s1');

    expect(s1View.envelopes.at(-1)).toMatchObject({
      type: 'event.session.status_changed',
      payload: { status: 'running', previous_status: 'awaiting_approval' },
    });
    expect(s2View.envelopes.at(-1)).toMatchObject({
      type: 'event.session.status_changed',
      session_id: 's1',
      payload: { status: 'running', previous_status: 'awaiting_approval' },
    });
  });

  it('does not re-announce interactions already pending at activation, but still broadcasts their resolution', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);
    // Pending before the session is activated — the snapshot covers it.
    lc.interactions.enqueue({
      id: 'q0',
      kind: 'question',
      payload: { questions: [{ question: 'Early', options: [{ label: 'A' }] }] },
    });

    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);
    await bc.getCursor('s1');
    expect(envelopes).toHaveLength(0);

    lc.interactions.respond('q0', { answers: { q_0: 'opt_0_0' } });
    await bc.getCursor('s1');
    expect(envelopes.map((e) => e.type)).toEqual([
      'event.question.answered',
      'event.session.status_changed',
    ]);
    expect(envelopes[1]!.payload).toMatchObject({
      status: 'idle',
      previous_status: 'awaiting_question',
    });
  });

  it('fans out the legacy background.task.* alias alongside native task.* for v1 clients', async () => {
    // v2 emits `task.started`/`task.terminated`; unchanged v1 consumers
    // (kimi-code TUI / `kimi -p`, node-sdk) only understand
    // `background.task.*`. The broadcaster must emit both spellings so web
    // (handles `task.*`, ignores the alias) and TUI (handles the alias, ignores
    // `task.*`) both work without consumer changes.
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    sessions.set('s1', lc);
    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target);

    const info = { taskId: 't1', status: 'running', description: 'ls' };
    main.bus.emit(agentEvent('task.started', { info }));
    main.bus.emit(agentEvent('task.terminated', { info: { ...info, status: 'completed' } }));
    await bc.getCursor('s1');

    expect(envelopes.map((e) => e.type)).toEqual([
      'task.started',
      'background.task.started',
      'task.terminated',
      'background.task.terminated',
    ]);
    // Alias carries the same payload, stamped with agentId/sessionId.
    expect(envelopes[1]!.payload).toMatchObject({
      type: 'background.task.started',
      info,
      agentId: 'main',
      sessionId: 's1',
    });
    expect(envelopes[3]!.payload).toMatchObject({
      type: 'background.task.terminated',
      agentId: 'main',
      sessionId: 's1',
    });
    // Native durability is preserved and the alias mirrors it (both journaled,
    // monotonic seq), so reconnecting v1 clients rebuild task state from replay.
    expect(envelopes.every((e) => e.volatile === undefined)).toBe(true);
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  // -------------------------------------------------------------------------
  // Per-agent subscription filter
  // -------------------------------------------------------------------------

  it('delivers only the allowlisted agent events on live fan-out', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    const sub = lc.addAgent('agent-0');
    sessions.set('s1', lc);

    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target, new Set(['main']));

    main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
    main.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
    sub.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
    await bc.getCursor('s1');

    // Agent events are filtered: only main's turn events are delivered.
    const agentEnvs = envelopes.filter((e) => e.type === 'turn.started' || e.type === 'turn.ended');
    expect(agentEnvs).toHaveLength(2);
    expect(
      agentEnvs.every((e) => (e.payload as { agentId: string }).agentId === 'main'),
    ).toBe(true);
    // `event.session.status_changed` is global (`event.session.*`) and bypasses
    // the agent filter. The sub-agent's turn.ended synthesizes no status change
    // at all (main-only rule — see the "does not synthesize session status from
    // sub-agent turn boundaries" test), so only the main agent's two transitions
    // are delivered.
    const statusEnvs = envelopes.filter((e) => e.type === 'event.session.status_changed');
    expect(statusEnvs).toHaveLength(2);
  });

  it('delivers every agent event when no filter is set', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    const sub = lc.addAgent('agent-0');
    sessions.set('s1', lc);

    const { target, envelopes } = collectingTarget();
    await bc.subscribe('s1', target); // no filter — legacy behavior

    main.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
    sub.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
    await bc.getCursor('s1');

    const agentIds = envelopes
      .filter((e) => e.type === 'turn.ended')
      .map((e) => (e.payload as { agentId: string }).agentId);
    expect(agentIds).toEqual(['main', 'agent-0']);
  });

  it('bypasses the agent filter for global events', async () => {
    const lc = new FakeLifecycle();
    lc.addAgent('main');
    sessions.set('s1', lc);

    const { target, envelopes } = collectingTarget();
    // Filter does not include 'main', yet global events must still be delivered.
    await bc.subscribe('s1', target, new Set(['agent-0']));

    eventBus.emit({
      type: 'session.meta.updated',
      payload: {
        agentId: 'main',
        sessionId: 's1',
        title: '测试',
        patch: { title: '测试' },
      },
    });

    await vi.waitFor(() => expect(envelopes).toHaveLength(1));
    expect(envelopes[0]!.type).toBe('session.meta.updated');
  });

  it('replays only the allowlisted agent events while keeping the global sequence', async () => {
    const lc = new FakeLifecycle();
    const main = lc.addAgent('main');
    const sub = lc.addAgent('agent-0');
    sessions.set('s1', lc);

    // Dedicated broadcaster with a cap large enough to hold the full mixed
    // turn/status sequence before the filter crop is exercised.
    const dir2 = await mkdtemp(join(tmpdir(), 'kimi-broadcaster-test-'));
    const bc2 = new SessionEventBroadcaster({
      eventsDir: dir2,
      core: makeCore(sessions, eventBus),
      maxBufferSize: 20,
    });
    try {
      // Activate the session and journal a mixed sequence before replaying.
      const warm = collectingTarget();
      await bc2.subscribe('s1', warm.target);
      main.bus.emit(agentEvent('turn.started', { turnId: 1 }));
      main.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
      sub.bus.emit(agentEvent('turn.started', { turnId: 1 }));
      sub.bus.emit(agentEvent('turn.ended', { turnId: 1 }));
      main.bus.emit(agentEvent('turn.started', { turnId: 2 }));
      main.bus.emit(agentEvent('turn.ended', { turnId: 2 }));
      await bc2.getCursor('s1');

      const result = await bc2.getBufferedSince('s1', { seq: 0 }, new Set(['main']));
      expect(result.resyncRequired).toBe(false);
      // The sub-agent's turn events are cropped (seq 5/6 — they synthesize no
      // status change), while the main agent's turns and the global status
      // transitions retain their original positions in the session sequence.
      expect(result.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 7, 8, 9, 10]);
      expect(
        result.events.every((e) => (e.envelope.payload as { agentId: string }).agentId === 'main'),
      ).toBe(true);
    } finally {
      await bc2.close();
      await rm(dir2, { recursive: true, force: true });
    }
  });
});
