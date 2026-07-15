/**
 * Scenario: high-frequency WebSocket render events reach the browser queue.
 * Responsibilities: preserve ordering, merge only proven-contiguous assistant
 * streams, bound each drain, keep a hidden-tab task fallback, and cancel stale
 * callbacks after flush. Wiring: real batcher/coalescer/reducer with only the
 * browser scheduler replaced by a manual public scheduler.
 * Run: pnpm --filter @moonshot-ai/kimi-web exec vitest run test/event-batcher.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createInitialState, reduceAppEvent, type KimiClientState } from '../src/api/daemon/eventReducer';
import type {
  AppEvent,
  AppMessage,
  AppSession,
  AppSessionSnapshot,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
} from '../src/api/types';
import {
  coalesceAppRenderEvents,
  createEventBatcher,
  isRenderEvent,
  splitOversizedAppRenderEvent,
  type EventBatcher,
  type EventBatcherScheduler,
  type PendingAppEvent,
} from '../src/composables/client/eventBatcher';

const clientApiMock = vi.hoisted(() => ({}));
const REASONABLE_MAX_STREAM_GROUP_CHARS = 64 * 1024;

vi.mock('../src/api', () => ({
  getKimiWebApi: () => clientApiMock,
}));

interface ManualScheduler extends EventBatcherScheduler {
  flushFrame(): void;
  flushTask(): void;
  pendingFrames(): number;
  pendingTasks(): number;
}

interface OwnedQueueItem {
  owner: string;
  kind: 'render' | 'control';
  id: string;
}

function manualScheduler(): ManualScheduler {
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  const tasks = new Map<number, () => void>();

  function takeOne(callbacks: Map<number, () => void>): void {
    const entry = callbacks.entries().next().value as [number, () => void] | undefined;
    if (entry === undefined) return;
    callbacks.delete(entry[0]);
    entry[1]();
  }

  return {
    requestFrame(callback) {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame(handle) {
      frames.delete(handle);
    },
    requestTask(callback) {
      const handle = nextHandle++;
      tasks.set(handle, callback);
      return handle;
    },
    cancelTask(handle) {
      tasks.delete(handle);
    },
    flushFrame() {
      takeOne(frames);
    },
    flushTask() {
      takeOne(tasks);
    },
    pendingFrames: () => frames.size,
    pendingTasks: () => tasks.size,
  };
}

interface DeltaOptions {
  sessionId?: string;
  messageId?: string;
  contentIndex?: number;
  turnId?: number;
  kind?: 'text' | 'thinking';
  stream?: boolean;
  seq?: number;
}

function pendingDelta(value: string, offset: number, options: DeltaOptions = {}): PendingAppEvent {
  const sessionId = options.sessionId ?? 'session-1';
  const kind = options.kind ?? 'text';
  return {
    appEvent: {
      type: 'assistantDelta',
      sessionId,
      messageId: options.messageId ?? 'message-1',
      contentIndex: options.contentIndex ?? 0,
      delta: kind === 'text' ? { text: value } : { thinking: value },
    },
    meta: {
      sessionId,
      seq: options.seq ?? offset + value.length,
      stream:
        options.stream === false
          ? undefined
          : {
              turnId: options.turnId ?? 1,
              offset,
              kind,
            },
    },
  };
}

function enqueueAppEvent(
  enqueue: EventBatcher<PendingAppEvent>,
  item: PendingAppEvent,
): void {
  for (const part of splitOversizedAppRenderEvent(item)) enqueue(part);
}

function assistantState(content: AppMessage['content'] = [{ type: 'text', text: '' }]): KimiClientState {
  const state = createInitialState();
  state.messagesBySession['session-1'] = [
    {
      id: 'message-1',
      sessionId: 'session-1',
      role: 'assistant',
      content,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  return state;
}

describe('createEventBatcher (ordered bounded scheduling)', () => {
  it('processes queued render items in arrival order when the frame runs', () => {
    const processed: string[] = [];
    const scheduler = manualScheduler();
    const enqueue = createEventBatcher<string>(
      (item) => processed.push(item),
      (item) => item.startsWith('d'),
      { scheduler },
    );

    enqueue('d1');
    enqueue('d2');
    enqueue('d3');

    expect(processed).toEqual([]);
    expect(scheduler.pendingFrames()).toBe(1);
    expect(scheduler.pendingTasks()).toBe(1);

    scheduler.flushFrame();

    expect(processed).toEqual(['d1', 'd2', 'd3']);
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTasks()).toBe(0);
  });

  it('processes a control item synchronously when no render item is pending', () => {
    const processed: string[] = [];
    const scheduler = manualScheduler();
    const enqueue = createEventBatcher<string>(
      (item) => processed.push(item),
      (item) => item.startsWith('d'),
      { scheduler },
    );

    enqueue('control');

    expect(processed).toEqual(['control']);
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTasks()).toBe(0);
  });

  it('keeps a control item behind prior render items when one slice is enough', () => {
    const processed: string[] = [];
    const scheduler = manualScheduler();
    const enqueue = createEventBatcher<string>(
      (item) => processed.push(item),
      (item) => item.startsWith('d'),
      { scheduler, maxItemsPerSlice: 10 },
    );

    enqueue('d1');
    enqueue('d2');
    enqueue('control');

    expect(processed).toEqual(['d1', 'd2', 'control']);
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTasks()).toBe(0);
  });

  it('continues on a later callback when a control item follows more than one slice', () => {
    const processed: string[] = [];
    const scheduler = manualScheduler();
    const enqueue = createEventBatcher<string>(
      (item) => processed.push(item),
      (item) => item.startsWith('d'),
      { scheduler, maxItemsPerSlice: 2 },
    );

    enqueue('d1');
    enqueue('d2');
    enqueue('d3');
    enqueue('control');
    enqueue('d4');

    expect(processed).toEqual(['d1', 'd2']);
    expect(scheduler.pendingFrames()).toBe(1);
    expect(scheduler.pendingTasks()).toBe(1);

    scheduler.flushFrame();

    expect(processed).toEqual(['d1', 'd2', 'd3', 'control']);
    expect(scheduler.pendingFrames()).toBe(1);
    expect(scheduler.pendingTasks()).toBe(1);

    scheduler.flushTask();

    expect(processed).toEqual(['d1', 'd2', 'd3', 'control', 'd4']);
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTasks()).toBe(0);
  });

  it('uses the task fallback when animation frames do not run', () => {
    const processed: string[] = [];
    const scheduler = manualScheduler();
    const enqueue = createEventBatcher<string>(
      (item) => processed.push(item),
      () => true,
      { scheduler },
    );

    enqueue('d1');
    enqueue('d2');
    scheduler.flushTask();

    expect(processed).toEqual(['d1', 'd2']);
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTasks()).toBe(0);
  });

  it('cancels scheduled callbacks when flush drains the queue authoritatively', () => {
    const processed: string[] = [];
    const scheduler = manualScheduler();
    const enqueue = createEventBatcher<string>(
      (item) => processed.push(item),
      () => true,
      { scheduler },
    );

    enqueue('d1');
    enqueue('d2');
    enqueue.flush();

    expect(processed).toEqual(['d1', 'd2']);
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTasks()).toBe(0);
  });

  it('discards a removed owner control item that remains beyond the slice budget', () => {
    const processed: string[] = [];
    const scheduler = manualScheduler();
    const enqueue = createEventBatcher<OwnedQueueItem>(
      (item) => processed.push(item.id),
      (item) => item.kind === 'render',
      { scheduler, maxItemsPerSlice: 2 },
    );

    enqueue({ owner: 'session-2', kind: 'render', id: 'session-2:d1' });
    enqueue({ owner: 'session-2', kind: 'render', id: 'session-2:d2' });
    enqueue({ owner: 'session-1', kind: 'render', id: 'session-1:d1' });
    enqueue({ owner: 'session-1', kind: 'control', id: 'session-1:idle' });
    expect(processed).toEqual(['session-2:d1', 'session-2:d2']);

    enqueue.discard((item) => item.owner === 'session-1');
    scheduler.flushFrame();
    scheduler.flushTask();

    expect(processed).toEqual(['session-2:d1', 'session-2:d2']);
  });

  it('preserves the order of items not discarded', () => {
    const processed: string[] = [];
    const scheduler = manualScheduler();
    const enqueue = createEventBatcher<string>(
      (item) => processed.push(item),
      () => true,
      { scheduler },
    );

    enqueue('session-1:d1');
    enqueue('session-2:d1');
    enqueue('session-1:d2');
    enqueue('session-2:d2');
    enqueue.discard((item) => item.startsWith('session-1:'));
    scheduler.flushFrame();

    expect(processed).toEqual(['session-2:d1', 'session-2:d2']);
  });

  it('cancels scheduled callbacks when discard empties the queue', () => {
    const scheduler = manualScheduler();
    const enqueue = createEventBatcher<string>(
      () => {},
      () => true,
      { scheduler },
    );

    enqueue('session-1:d1');
    enqueue('session-1:d2');
    expect(scheduler.pendingFrames()).toBe(1);
    expect(scheduler.pendingTasks()).toBe(1);

    enqueue.discard((item) => item.startsWith('session-1:'));

    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTasks()).toBe(0);
  });

  it('cancels scheduled work once when dispose is repeated', () => {
    const processed: string[] = [];
    const scheduler = manualScheduler();
    const cancelFrame = vi.spyOn(scheduler, 'cancelFrame');
    const cancelTask = vi.spyOn(scheduler, 'cancelTask');
    const enqueue = createEventBatcher<string>(
      (item) => processed.push(item),
      () => true,
      { scheduler },
    );

    enqueue('d1');
    enqueue('d2');
    expect(scheduler.pendingFrames()).toBe(1);
    expect(scheduler.pendingTasks()).toBe(1);

    enqueue.dispose();
    enqueue.dispose();
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTasks()).toBe(0);
    expect(cancelFrame).toHaveBeenCalledTimes(1);
    expect(cancelTask).toHaveBeenCalledTimes(1);

    scheduler.flushFrame();
    scheduler.flushTask();
    expect(processed).toEqual([]);
  });

  it('ignores items enqueued after dispose without scheduling callbacks', () => {
    const processed: string[] = [];
    const scheduler = manualScheduler();
    const enqueue = createEventBatcher<string>(
      (item) => processed.push(item),
      () => true,
      { scheduler },
    );

    enqueue.dispose();
    enqueue('d3');
    enqueue.flush();

    expect(processed).toEqual([]);
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTasks()).toBe(0);
  });
});

describe('coalesceAppRenderEvents (lossless stream grouping)', () => {
  it('reduces 10,000 contiguous deltas in capped groups while preserving every character', () => {
    const scheduler = manualScheduler();
    let state = assistantState();
    let reducerCalls = 0;
    const groupLengths: number[] = [];
    const groupOffsets: number[] = [];
    const enqueue = createEventBatcher<PendingAppEvent>(
      ({ appEvent, meta }) => {
        reducerCalls += 1;
        groupLengths.push(
          appEvent.type === 'assistantDelta' ? (appEvent.delta.text?.length ?? 0) : 0,
        );
        groupOffsets.push(meta.stream?.offset ?? -1);
        state = reduceAppEvent(state, appEvent, meta);
      },
      ({ appEvent }) => isRenderEvent(appEvent),
      { scheduler, coalesce: coalesceAppRenderEvents },
    );

    for (let index = 0; index < 10_000; index += 1) {
      enqueueAppEvent(enqueue, pendingDelta('abcdefghijklmnop', index * 16));
    }

    expect(scheduler.pendingFrames()).toBe(1);
    expect(scheduler.pendingTasks()).toBe(1);
    scheduler.flushFrame();

    expect(reducerCalls).toBeGreaterThan(1);
    expect(reducerCalls).toBeLessThan(100);
    expect(
      groupLengths.every((length) => length <= REASONABLE_MAX_STREAM_GROUP_CHARS),
    ).toBe(true);
    let expectedOffset = 0;
    for (let index = 0; index < groupOffsets.length; index += 1) {
      expect(groupOffsets[index]).toBe(expectedOffset);
      expectedOffset += groupLengths[index]!;
    }
    expect(state.lastSeqBySession['session-1']).toBe(160_000);
    expect(state.messagesBySession['session-1']?.[0]?.content).toEqual([
      { type: 'text', text: 'abcdefghijklmnop'.repeat(10_000) },
    ]);
  });

  it('keeps a 10,000-delta hidden-tab backlog in a few capped groups', () => {
    const scheduler = manualScheduler();
    const processed: PendingAppEvent[] = [];
    const enqueue = createEventBatcher<PendingAppEvent>(
      (item) => processed.push(item),
      ({ appEvent }) => isRenderEvent(appEvent),
      { scheduler, coalesce: coalesceAppRenderEvents },
    );

    for (let index = 0; index < 10_000; index += 1) {
      enqueueAppEvent(enqueue, pendingDelta('abcdefghijklmnop', index * 16));
    }

    expect(processed).toEqual([]);
    expect(scheduler.pendingFrames()).toBe(1);
    expect(scheduler.pendingTasks()).toBe(1);

    scheduler.flushTask();

    expect(processed.length).toBeGreaterThan(1);
    expect(processed.length).toBeLessThan(100);
    expect(
      processed.every(
        ({ appEvent }) =>
          appEvent.type === 'assistantDelta' &&
          (appEvent.delta.text?.length ?? 0) <= REASONABLE_MAX_STREAM_GROUP_CHARS,
      ),
    ).toBe(true);
    let expectedOffset = 0;
    for (const item of processed) {
      expect(item.meta.stream?.offset).toBe(expectedOffset);
      if (item.appEvent.type === 'assistantDelta') {
        expectedOffset += item.appEvent.delta.text?.length ?? 0;
      }
    }
    expect(
      processed
        .map(({ appEvent }) =>
          appEvent.type === 'assistantDelta' ? (appEvent.delta.text ?? '') : '',
        )
        .join(''),
    ).toBe('abcdefghijklmnop'.repeat(10_000));
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTasks()).toBe(0);
  });

  it('splits one oversized incoming delta without breaking a surrogate pair', () => {
    const value = '\ud83d\ude00'.repeat(50_000) + 'tail';

    const parts = splitOversizedAppRenderEvent(pendingDelta(value, 7));

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThan(100);
    let expectedOffset = 7;
    for (const part of parts) {
      expect(part.meta.stream?.offset).toBe(expectedOffset);
      expect(part.meta.seq).toBe(7 + value.length);
      if (part.appEvent.type === 'assistantDelta') {
        const text = part.appEvent.delta.text ?? '';
        expect(text.length).toBeLessThanOrEqual(REASONABLE_MAX_STREAM_GROUP_CHARS);
        expect(/[\uD800-\uDBFF]$/u.test(text)).toBe(false);
        expect(/^[\uDC00-\uDFFF]/u.test(text)).toBe(false);
        expectedOffset += text.length;
      }
    }
    expect(
      parts.every(
        ({ appEvent }) =>
          appEvent.type === 'assistantDelta' &&
          (appEvent.delta.text?.length ?? 0) <= REASONABLE_MAX_STREAM_GROUP_CHARS,
      ),
    ).toBe(true);
    expect(
      parts
        .map(({ appEvent }) =>
          appEvent.type === 'assistantDelta' ? (appEvent.delta.text ?? '') : '',
        )
        .join(''),
    ).toBe(value);
  });

  it.each([
    ['session differs', pendingDelta('b', 1, { sessionId: 'session-2' })],
    ['turn differs', pendingDelta('b', 1, { turnId: 2 })],
    ['message differs', pendingDelta('b', 1, { messageId: 'message-2' })],
    ['content index differs', pendingDelta('b', 1, { contentIndex: 1 })],
    ['delta kind differs', pendingDelta('b', 1, { kind: 'thinking' })],
    ['offset is not contiguous', pendingDelta('b', 2)],
    ['stream coordinates are missing', pendingDelta('b', 1, { stream: false })],
  ])('keeps adjacent deltas separate when %s', (_condition, next) => {
    const scheduler = manualScheduler();
    let processed = 0;
    const enqueue = createEventBatcher<PendingAppEvent>(
      () => {
        processed += 1;
      },
      ({ appEvent }) => isRenderEvent(appEvent),
      { scheduler, coalesce: coalesceAppRenderEvents },
    );

    enqueue(pendingDelta('a', 0));
    enqueue(next);
    scheduler.flushFrame();

    expect(processed).toBe(2);
  });

  it('coalesces contiguous thinking deltas into the existing thinking block', () => {
    const scheduler = manualScheduler();
    let state = assistantState([{ type: 'thinking', thinking: 'seed' }]);
    const enqueue = createEventBatcher<PendingAppEvent>(
      ({ appEvent, meta }) => {
        state = reduceAppEvent(state, appEvent, meta);
      },
      ({ appEvent }) => isRenderEvent(appEvent),
      { scheduler, coalesce: coalesceAppRenderEvents },
    );

    enqueue(pendingDelta(' one', 0, { kind: 'thinking' }));
    enqueue(pendingDelta(' two', 4, { kind: 'thinking' }));
    scheduler.flushFrame();

    expect(state.messagesBySession['session-1']?.[0]?.content).toEqual([
      { type: 'thinking', thinking: 'seed one two', signature: undefined },
    ]);
  });

  it('does not reapply a pre-snapshot delta after the snapshot seeds live text', () => {
    const scheduler = manualScheduler();
    let state = assistantState();
    const enqueue = createEventBatcher<PendingAppEvent>(
      ({ appEvent, meta }) => {
        state = reduceAppEvent(state, appEvent, meta);
      },
      ({ appEvent }) => isRenderEvent(appEvent),
      { scheduler, coalesce: coalesceAppRenderEvents },
    );

    enqueue(pendingDelta('stale', 0));
    enqueue.flush();
    state = assistantState([{ type: 'text', text: 'snapshot' }]);
    enqueue(pendingDelta(' live', 8));
    scheduler.flushFrame();

    expect(state.messagesBySession['session-1']?.[0]?.content).toEqual([
      { type: 'text', text: 'snapshot live' },
    ]);
    expect(scheduler.pendingFrames()).toBe(0);
    expect(scheduler.pendingTasks()).toBe(0);
  });
});

describe('useKimiWebClient (resync integration)', () => {
  it('flushes queued deltas around an authoritative snapshot before live streaming resumes', async () => {
    vi.stubGlobal('WebSocket', class {});

    const sessionId = 'session-1';
    const session: AppSession = {
      id: sessionId,
      title: 'Session',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
      archived: false,
      currentPromptId: 'prompt-1',
      cwd: '/workspace',
      model: 'model-1',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        contextTokens: 0,
        contextLimit: 0,
        turnCount: 1,
      },
      messageCount: 1,
      lastSeq: 10,
      workspaceId: 'workspace-1',
    };
    const snapshot = (text: string, asOfSeq: number, epoch: string): AppSessionSnapshot => ({
      asOfSeq,
      epoch,
      session: { ...session, lastSeq: asOfSeq },
      messages: [
        {
          id: 'message-1',
          sessionId,
          role: 'assistant',
          content: [{ type: 'text', text }],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      hasMoreMessages: false,
      inFlightTurn: {
        turnId: 1,
        assistantText: text,
        thinkingText: '',
        runningTools: [],
        promptId: 'prompt-1',
      },
      subagents: [],
      pendingApprovals: [],
      pendingQuestions: [],
    });
    const initialSnapshot = snapshot('seed', 10, 'epoch-1');
    const authoritativeSnapshot = snapshot('snapshot', 20, 'epoch-2');

    let handlers: KimiEventHandlers | undefined;
    let resolveSnapshotRequest!: () => void;
    const snapshotRequested = new Promise<void>((resolve) => {
      resolveSnapshotRequest = resolve;
    });
    let resolveAuthoritativeSnapshot!: (value: AppSessionSnapshot) => void;
    const authoritativeSnapshotResponse = new Promise<AppSessionSnapshot>((resolve) => {
      resolveAuthoritativeSnapshot = resolve;
    });
    let resolveSnapshotApplied!: () => void;
    const snapshotApplied = new Promise<void>((resolve) => {
      resolveSnapshotApplied = resolve;
    });
    let snapshotCalls = 0;
    const getSessionSnapshot = vi.fn((_id: string) => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) return Promise.resolve(initialSnapshot);
      resolveSnapshotRequest();
      return authoritativeSnapshotResponse;
    });
    let seedCalls = 0;
    const connection: KimiEventConnection = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      bindNextPromptId: vi.fn(),
      seedSnapshot: vi.fn(() => {
        seedCalls += 1;
        if (seedCalls === 2) resolveSnapshotApplied();
      }),
      abort: vi.fn(),
      terminalAttach: vi.fn(),
      terminalInput: vi.fn(),
      terminalResize: vi.fn(),
      terminalDetach: vi.fn(),
      terminalClose: vi.fn(),
      markSideChannelAgent: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({
        ready: true,
        defaultModel: 'model-1',
        managedProvider: null,
      })),
      getHealth: vi.fn(async () => ({ status: 'ok', uptimeSec: 1 })),
      getMeta: vi.fn(async () => ({
        serverVersion: '0.0.0',
        serverId: 'server-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        capabilities: {},
        openInApps: [],
        dangerousBypassAuth: false,
        backend: 'v2',
      })),
      getConfig: vi.fn(async () => ({ providers: {}, defaultModel: 'model-1' })),
      listModels: vi.fn(async () => []),
      listProviders: vi.fn(async () => []),
      listWorkspaces: vi.fn(async () => [
        {
          id: 'workspace-1',
          root: '/workspace',
          name: 'Workspace',
          isGitRepo: false,
          sessionCount: 1,
        },
      ]),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: [session], hasMore: false })),
      getSessionSnapshot,
      getSessionStatus: vi.fn(async () => ({
        model: 'model-1',
        thinkingEffort: 'high',
        permission: 'manual',
        planMode: false,
        swarmMode: false,
        contextTokens: 0,
        maxContextTokens: 0,
        contextUsage: 0,
      })),
      getSessionGoal: vi.fn(async () => null),
      getSessionWarnings: vi.fn(async () => []),
      getGitStatus: vi.fn(async () => ({
        branch: '',
        ahead: 0,
        behind: 0,
        entries: {},
        additions: 0,
        deletions: 0,
        pullRequest: null,
      })),
      listTasks: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      getFileUrl: (fileId) => `file:${fileId}`,
      connectEvents: vi.fn((nextHandlers) => {
        handlers = nextHandlers;
        return connection;
      }),
    };
    for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
    Object.assign(clientApiMock, api);

    try {
      const { useKimiWebClient } = await import('../src/composables/useKimiWebClient');
      const client = useKimiWebClient();
      await client.load();
      const assistantText = (): string | undefined =>
        client.turns.value.find((turn) => turn.role === 'assistant')?.text;

      expect(assistantText()).toBe('seed');
      expect(handlers).toBeDefined();

      const beforeResync = pendingDelta('before', 4, { seq: 11 });
      handlers!.onEvent(beforeResync.appEvent, beforeResync.meta);
      handlers!.onResync(sessionId, 11, 'epoch-2');

      // onResync synchronously drains pre-resync text onto the old state.
      expect(assistantText()).toBe('seedbefore');
      await snapshotRequested;

      // A frame can race the REST request. The second flush must consume it on
      // the old state before the authoritative snapshot replaces that state.
      const duringSnapshot = pendingDelta('old', 10, { seq: 12 });
      handlers!.onEvent(duringSnapshot.appEvent, duringSnapshot.meta);
      resolveAuthoritativeSnapshot(authoritativeSnapshot);
      await snapshotApplied;
      expect(assistantText()).toBe('snapshot');

      const live = pendingDelta(' live', 8, { seq: 21 });
      handlers!.onEvent(live.appEvent, live.meta);
      handlers!.onEvent(
        { type: 'sessionMetaUpdated', sessionId, title: 'Session' },
        { sessionId, seq: 22 },
      );

      expect(assistantText()).toBe('snapshot live');
    } finally {
      connection.close();
      vi.unstubAllGlobals();
    }
  });
});

describe('isRenderEvent (queue classification)', () => {
  it.each(['assistantDelta', 'agentDelta', 'toolOutput', 'taskProgress'])(
    'classifies %s as a render event',
    (type) => {
      expect(isRenderEvent({ type } as AppEvent)).toBe(true);
    },
  );

  it.each(['messageCreated', 'messageUpdated', 'sessionStatusChanged', 'approvalRequested', 'configChanged'])(
    'classifies %s as a control event',
    (type) => {
      expect(isRenderEvent({ type } as AppEvent)).toBe(false);
    },
  );
});
