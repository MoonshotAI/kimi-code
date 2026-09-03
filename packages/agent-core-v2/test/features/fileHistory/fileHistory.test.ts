import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { popConstructionFrame, pushConstructionFrame } from '#/_base/di/fiber';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { IEventBus, type ISessionEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import type { IFlagService } from '#/app/flag/flag';
import { IAgentFileHistoryService } from '#/features/fileHistory/fileHistory';
import { AgentFileHistoryService, countLineDiff } from '#/features/fileHistory/fileHistoryService';
import { displacedCheckpoints } from '#/features/fileHistory/fileHistoryOps';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { FILE_HISTORY_FLAG_ENV } from '#/features/fileHistory/flag';
import type { ToolCall } from '#/kosong/contract/message';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { BlobStoreService } from '#/persistence/backends/node-fs/blobStoreService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import type { RunnableToolExecution } from '#/tool/toolContract';

import { createFakeHostFs } from '../../tools/fixtures/fake-exec';
import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../../agent/toolExecutor/stubs';
import { registerTestAgentWire, registerTestEventDispatcher, testWireScope } from '../../wire/stubs';
import { createTestAgent } from '../../harness';

const SCOPE = 'wire';
const KEY = 'file-history-test';
const WORK_DIR = '/ws';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('AgentFileHistoryService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let executorEvents: ToolExecutorEventStubs;
  let eventBus: IEventBus;
  let blobs: IBlobStore;
  let scopeCtx: IAgentScopeContext;
  let files: Map<string, Uint8Array>;
  let flagEnabled: boolean;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    registerTestAgentWire(ix, testWireScope(SCOPE, KEY), {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
    });
    scopeCtx = makeAgentScopeContext({ agentId: 'main', agentScope: testWireScope(SCOPE, KEY) });
    ix.stub(IAgentScopeContext, scopeCtx);
    registerTestEventDispatcher(ix);
    eventBus = ix.get(IEventBus);
    const sessionBus = eventBus as Partial<ISessionEventBus>;
    if (typeof sessionBus.activateAgent === 'function') {
      sessionBus.activateAgent(scopeCtx.agentContext);
    }
    executorEvents = stubToolExecutorEvents();
    blobs = new BlobStoreService(new InMemoryStorageService());
    files = new Map();
    flagEnabled = true;
  });

  afterEach(() => {
    disposables.dispose();
  });

  function stubRuntime(): IAgentRuntimeService {
    return {
      acquire: () => ({
        runtime: {
          fs: hostFs(),
          path: posix,
          workspace: { mapRoots: (roots: unknown) => roots },
        },
        dispose: () => {},
      }),
    } as unknown as IAgentRuntimeService;
  }

  function hostFs(): IHostFileSystem {
    return createFakeHostFs({
      stat: async (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { isFile: true, isDirectory: false, size: content.byteLength };
      },
      readBytes: async (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return content;
      },
    });
  }

  function createService(agentId = 'main'): AgentFileHistoryService {
    const ctx =
      agentId === scopeCtx.agentId
        ? scopeCtx
        : makeAgentScopeContext({ agentId, agentScope: testWireScope(SCOPE, KEY) });
    const flags = { enabled: () => flagEnabled } as unknown as IFlagService;
    const workspace = {
      workDir: WORK_DIR,
      additionalDirs: [],
    } as unknown as ISessionWorkspaceContext;
    pushConstructionFrame({
      ctor: AgentFileHistoryService,
      config: undefined,
      token: undefined,
      host: undefined as never,
    });
    try {
      return disposables.add(
        new AgentFileHistoryService(
        ctx,
        ix.get(IAgentStateService),
        executorEvents.executor,
        eventBus,
        ix.get(IEventDispatcher),
        flags,
        stubRuntime(),
            blobs,
          workspace,
          {
            _serviceBrand: undefined,
            sessionId: 'test-session',
            workspaceId: 'wd_test',
            sessionDir: '/history-home/sessions/wd_test/test-session',
            metaScope: 'sessions/wd_test/test-session/session-meta',
            cwd: WORK_DIR,
            scope: (subKey?: string): string =>
              subKey === undefined || subKey === ''
                ? 'sessions/wd_test/test-session'
                : `sessions/wd_test/test-session/${subKey}`,
          } as ISessionContext,
          new JsonAtomicDocumentStore(ix.get(IFileSystemStorageService)),
          {
            readdir: async () => [],
            remove: async () => {},
          } as unknown as IHostFileSystem,
          { handleOf: () => undefined } as unknown as IAgentLifecycleService,
        ),
      );
    } finally {
      popConstructionFrame();
    }
  }

  function setFile(path: string, content: string): void {
    files.set(path, encoder.encode(content));
  }

  async function fireEdit(service: AgentFileHistoryService, path: string, turnId: number): Promise<void> {
    const toolCall: ToolCall = { type: 'function', id: `call-${String(turnId)}`, name: 'Edit', arguments: null };
    const execution: RunnableToolExecution = {
      approvalRule: 'Edit',
      display: { kind: 'file_io', operation: 'edit', path },
      execute: async () => ({ output: '' }),
    };
    await executorEvents.fireWillExecute(
      { turnId, toolCall, execution, args: {} },
      new AbortController().signal,
    );
    await service.settled();
  }

  function startTurn(turnId: number): void {
    eventBus.publish(
      new TurnStarted({ agentId: 'main', turnId, origin: USER_PROMPT_ORIGIN }),
      scopeCtx.agentContext,
    );
  }

  function endTurn(turnId: number): void {
    eventBus.publish(
      new TurnEnded({ agentId: 'main', turnId, reason: 'completed' }),
      scopeCtx.agentContext,
    );
  }

  async function blobText(key: string): Promise<string | undefined> {
    const bytes = await blobs.get(scopeCtx.scope(), key);
    return bytes === undefined ? undefined : decoder.decode(bytes);
  }

  it('backs up pre-edit content on first touch and versions changes at the next turn boundary', async () => {
    const service = createService();
    setFile('/ws/a.txt', 'one\ntwo\n');

    startTurn(1);
    await fireEdit(service, '/ws/a.txt', 1);

    let state = service.history();
    expect(state.tracked).toEqual(['a.txt']);
    const v1 = state.checkpoints.find((c) => c.turnId === 1)?.entries['a.txt'];
    expect(v1?.version).toBe(1);
    expect(await blobText(v1!.key!)).toBe('one\ntwo\n');

    setFile('/ws/a.txt', 'one\nTWO\n');
    await fireEdit(service, '/ws/a.txt', 1);
    state = service.history();
    expect(Object.values(state.checkpoints.find((c) => c.turnId === 1)!.entries)).toHaveLength(1);

    endTurn(1);
    startTurn(2);
    await service.settled();
    state = service.history();
    const v2 = state.checkpoints.find(
      (c) => c.turnId === 1 && c.phase === 'end',
    )?.entries['a.txt'];
    expect(v2?.version).toBe(2);
    expect(await blobText(v2!.key!)).toBe('one\nTWO\n');

    expect(await service.changes(1)).toEqual([
      { path: 'a.txt', status: 'modified', additions: 1, deletions: 1 },
    ]);
    expect((await service.contentAt(1, 'a.txt'))?.content).toBe('one\ntwo\n');
    expect((await service.contentAt(1, '/ws/a.txt', 'end'))?.content).toBe('one\nTWO\n');
    expect(await service.contentAt(2, '/ws/a.txt')).toBeUndefined();
  });

  it('merges overlapping edits within one turn into a single true diff', async () => {
    const service = createService();
    setFile('/ws/a.txt', 'alpha\nbeta\n');

    startTurn(1);
    await fireEdit(service, '/ws/a.txt', 1);
    setFile('/ws/a.txt', 'alpha\nbeta\ngamma\n');
    await fireEdit(service, '/ws/a.txt', 1);
    setFile('/ws/a.txt', 'alpha\nGAMMA\n');
    await fireEdit(service, '/ws/a.txt', 1);

    endTurn(1);
    startTurn(2);
    await service.settled();

    expect(await service.changes(1)).toEqual([
      { path: 'a.txt', status: 'modified', additions: 1, deletions: 1 },
    ]);
  });

  it('reuses the previous backup when a tracked file is unchanged at a turn boundary', async () => {
    const service = createService();
    setFile('/ws/b.txt', 'stable\n');

    startTurn(1);
    await fireEdit(service, '/ws/b.txt', 1);
    endTurn(1);
    startTurn(2);
    endTurn(2);
    startTurn(3);
    await service.settled();

    const state = service.history();
    const entryAtTurn2 = state.checkpoints.find((c) => c.turnId === 2)?.entries['b.txt'];
    const entryAtTurn3 = state.checkpoints.find((c) => c.turnId === 3)?.entries['b.txt'];
    expect(entryAtTurn2).toBeUndefined();
    expect(entryAtTurn3).toBeUndefined();
    const keys = await blobs.list(scopeCtx.scope(), 'file-history/');
    expect(keys).toHaveLength(1);
    expect(await service.changes(1)).toEqual([]);
  });

  it('records file creation and deletion across turns', async () => {
    const service = createService();

    startTurn(1);
    await fireEdit(service, '/ws/new.txt', 1);
    let entry = service.history().checkpoints.find((c) => c.turnId === 1)?.entries['new.txt'];
    expect(entry).toEqual({ key: null, version: 1 });

    setFile('/ws/new.txt', 'created\n');
    endTurn(1);
    startTurn(2);
    await service.settled();
    expect(await service.changes(1)).toEqual([
      { path: 'new.txt', status: 'added', additions: 1, deletions: 0 },
    ]);

    await fireEdit(service, '/ws/new.txt', 2);
    files.delete('/ws/new.txt');
    endTurn(2);
    startTurn(3);
    await service.settled();
    entry = service
      .history()
      .checkpoints.find((c) => c.turnId === 2 && c.phase === 'end')?.entries['new.txt'];
    expect(entry?.key).toBeNull();
    expect(await service.changes(2)).toEqual([
      { path: 'new.txt', status: 'deleted', additions: 0, deletions: 1 },
    ]);
  });

  it('does nothing while the flag is off', async () => {
    flagEnabled = false;
    const service = createService();
    setFile('/ws/a.txt', 'content\n');

    startTurn(1);
    await fireEdit(service, '/ws/a.txt', 1);
    await service.settled();

    const state = service.history();
    expect(state.checkpoints).toEqual([]);
    expect(state.tracked).toEqual([]);
  });

  it('excludes user edits between turns via the end-of-turn checkpoint', async () => {
    const service = createService();
    setFile('/ws/a.txt', 'alpha\n');

    startTurn(1);
    await fireEdit(service, '/ws/a.txt', 1);
    setFile('/ws/a.txt', 'alpha\nagent\n');
    endTurn(1);
    await service.settled();

    setFile('/ws/a.txt', 'alpha\nagent\nuser\n');
    startTurn(2);
    endTurn(2);
    await service.settled();

    expect(await service.changes(1)).toEqual([
      { path: 'a.txt', status: 'modified', additions: 1, deletions: 0 },
    ]);
    expect(await service.changes(2)).toEqual([]);
    expect((await service.contentAt(1, 'a.txt', 'end'))?.content).toBe('alpha\nagent\n');
    expect(await service.contentAt(2, 'a.txt')).toBeUndefined();
  });

  it('guards reads once the flag is turned off after data was recorded', async () => {
    const service = createService();
    setFile('/ws/a.txt', 'content\n');

    startTurn(1);
    await fireEdit(service, '/ws/a.txt', 1);
    setFile('/ws/a.txt', 'changed\n');
    endTurn(1);
    startTurn(2);
    await service.settled();
    expect(await service.changes(1)).toEqual([
      { path: 'a.txt', status: 'modified', additions: 1, deletions: 1 },
    ]);
    expect((await service.contentAt(1, 'a.txt'))?.content).toBe('content\n');

    flagEnabled = false;
    expect(await service.changes(1)).toEqual([]);
    expect(await service.contentAt(1, 'a.txt')).toBeUndefined();
  });

  it('reports an over-budget modified file as oversize with no counts', async () => {
    const service = createService();
    const bigA = Array.from({ length: 2500 }, (_, i) => `a-${String(i)}`).join('\n');
    const bigB = Array.from({ length: 2500 }, (_, i) => `b-${String(i)}`).join('\n');
    setFile('/ws/big.txt', bigA);

    startTurn(1);
    await fireEdit(service, '/ws/big.txt', 1);
    setFile('/ws/big.txt', bigB);
    endTurn(1);
    startTurn(2);
    await service.settled();

    expect(await service.changes(1)).toEqual([
      { path: 'big.txt', status: 'modified', additions: 0, deletions: 0, oversize: true },
    ]);
  });

  it('declines to count over-budget file pairs instead of approximating', () => {
    const before = [...Array.from({ length: 3000 }, () => 'dup'), 'end-old'].join('\n');
    const after = ['start-new', ...Array.from({ length: 2100 }, () => 'dup')].join('\n');
    expect(countLineDiff(before, after)).toBeUndefined();

    const body = Array.from({ length: 3000 }, (_, i) => `line-${String(i)}`);
    expect(countLineDiff(['moved', ...body].join('\n'), [...body, 'moved'].join('\n'))).toBeUndefined();
  });

  it('stays inactive on subagents', async () => {
    const service = createService('sub-1');
    setFile('/ws/a.txt', 'content\n');

    startTurn(1);
    await fireEdit(service, '/ws/a.txt', 1);
    await service.settled();

    expect(service.history().checkpoints).toEqual([]);
  });

  it('drops turns outside the retention window and re-baselines returning files', async () => {
    const service = createService();
    setFile('/ws/w.txt', 'v1\n');

    startTurn(1);
    await fireEdit(service, '/ws/w.txt', 1);
    setFile('/ws/w.txt', 'v2\n');
    endTurn(1);
    await service.settled();
    for (let turn = 2; turn <= 6; turn += 1) {
      startTurn(turn);
      await fireEdit(service, `/ws/filler-${String(turn)}.txt`, turn);
      endTurn(turn);
    }
    await service.settled();

    const state = service.history();
    expect(Math.min(...state.checkpoints.map((c) => c.turnId))).toBeGreaterThanOrEqual(2);
    expect(state.tracked).not.toContain('w.txt');
    expect(await blobs.list(scopeCtx.scope(), 'file-history/')).toEqual([]);
    expect(await service.changes(1)).toEqual([]);

    startTurn(7);
    await fireEdit(service, '/ws/w.txt', 7);
    await service.settled();
    const entry = service.history().checkpoints.find((c) => c.turnId === 7)?.entries['w.txt'];
    expect(entry?.version).toBe(1);
    expect(await blobText(entry!.key!)).toBe('v2\n');
  });

  it('keeps window-edge turns resolvable after older checkpoints are pruned', async () => {
    const service = createService();
    setFile('/ws/e.txt', 'one\n');

    startTurn(1);
    await fireEdit(service, '/ws/e.txt', 1);
    setFile('/ws/e.txt', 'two\n');
    endTurn(1);
    startTurn(3);
    await fireEdit(service, '/ws/e.txt', 3);
    setFile('/ws/e.txt', 'three\n');
    endTurn(3);
    for (let turn = 4; turn <= 7; turn += 1) {
      startTurn(turn);
      await fireEdit(service, `/ws/filler-${String(turn)}.txt`, turn);
      endTurn(turn);
    }
    await service.settled();

    expect(service.history().checkpoints.some((c) => c.turnId < 3)).toBe(false);
    expect(await service.changes(3)).toEqual([
      { path: 'e.txt', status: 'modified', additions: 1, deletions: 1 },
    ]);
    expect((await service.contentAt(3, 'e.txt'))?.content).toBe('two\n');
    expect(await service.turnRecorded(3)).toBe(true);
    expect(await service.turnRecorded(1)).toBe(false);
    expect(await service.turnRecorded(2)).toBe(false);

    const keyed = Object.values(
      service.history().checkpoints.find((c) => c.turnId === 3 && c.phase === 'end')!.entries,
    ).find((entry) => entry.key !== null);
    await blobs.delete(scopeCtx.scope(), keyed!.key!);
    expect(await service.turnRecorded(3)).toBe(false);
  });

  it('keeps a shared baseline blob alive until its last window reference leaves', async () => {
    const service = createService();
    setFile('/ws/s.txt', 'base\n');

    startTurn(1);
    await fireEdit(service, '/ws/s.txt', 1);
    setFile('/ws/s.txt', 'edited\n');
    endTurn(1);
    startTurn(3);
    await fireEdit(service, '/ws/s.txt', 3);
    endTurn(3);
    await service.settled();

    const start3 = service.history().checkpoints.find(
      (c) => c.turnId === 3 && c.phase === 'start',
    )?.entries['s.txt'];
    const end1 = service.history().checkpoints.find(
      (c) => c.turnId === 1 && c.phase === 'end',
    )?.entries['s.txt'];
    expect(start3?.key).toBe(end1?.key);

    for (let turn = 4; turn <= 7; turn += 1) {
      startTurn(turn);
      await fireEdit(service, `/ws/filler-${String(turn)}.txt`, turn);
      endTurn(turn);
    }
    await service.settled();
    expect(service.history().checkpoints.some((c) => c.turnId < 3)).toBe(false);
    expect(await blobText(start3!.key!)).toBe('edited\n');
    expect((await service.contentAt(3, 's.txt'))?.content).toBe('edited\n');

    startTurn(8);
    await fireEdit(service, '/ws/filler-8.txt', 8);
    endTurn(8);
    await service.settled();
    expect(await blobs.list(scopeCtx.scope(), 'file-history/')).toEqual([]);
  });

  it('keeps files outside the workspace keyed by absolute path', async () => {
    const service = createService();
    setFile('/elsewhere/notes.md', 'note\n');

    startTurn(1);
    await fireEdit(service, '/elsewhere/notes.md', 1);

    expect(service.history().tracked).toEqual(['/elsewhere/notes.md']);
  });
});

describe('file history through real scripted turns', () => {
  beforeEach(() => {
    process.env[FILE_HISTORY_FLAG_ENV] = '1';
  });

  afterEach(() => {
    delete process.env[FILE_HISTORY_FLAG_ENV];
  });

  it('checkpoints edits across turns and serves exact per-turn changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'file-history-e2e-'));
    const file = join(dir, 'notes.txt');
    await writeFile(file, 'alpha\nbeta\n');
    const ctx = createTestAgent();
    try {
      await ctx.rpc.setPermission({ mode: 'yolo' });

      const editCall = (id: string, oldString: string, newString: string): ToolCall => ({
        type: 'function',
        id,
        name: 'Edit',
        arguments: JSON.stringify({ path: file, old_string: oldString, new_string: newString }),
      });
      const readCall: ToolCall = {
        type: 'function',
        id: 'call_r1',
        name: 'Read',
        arguments: JSON.stringify({ path: file }),
      };
      ctx.mockNextResponse({ type: 'text', text: 'Reading.' }, readCall);
      ctx.mockNextResponse({ type: 'text', text: 'First edit.' }, editCall('call_e1', 'beta', 'gamma'));
      ctx.mockNextResponse({ type: 'text', text: 'Second edit.' }, editCall('call_e2', 'gamma', 'delta'));
      ctx.mockNextResponse({ type: 'text', text: 'Done.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Edit the file twice' }] });
      await ctx.untilTurnEnd();

      ctx.mockNextResponse({ type: 'text', text: 'Nothing else.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Thanks' }] });
      await ctx.untilTurnEnd();

      const service = ctx.get(IAgentFileHistoryService);
      await service.settled();
      expect(await readFile(file, 'utf8')).toBe('alpha\ndelta\n');

      const state = service.history();
      expect(state.tracked).toEqual([file]);
      const startOfTurn0 = state.checkpoints.find((c) => c.turnId === 0);
      const endOfTurn0 = state.checkpoints.find((c) => c.turnId === 0 && c.phase === 'end');
      const startOfTurn1 = state.checkpoints.find((c) => c.turnId === 1);
      expect(startOfTurn0?.entries[file]?.version).toBe(1);
      expect(endOfTurn0?.entries[file]?.version).toBe(2);
      expect(startOfTurn1?.entries[file]).toBeUndefined();

      expect((await service.contentAt(0, file))?.content).toBe('alpha\nbeta\n');
      expect((await service.contentAt(0, file, 'end'))?.content).toBe('alpha\ndelta\n');
      expect(await service.contentAt(1, file)).toBeUndefined();

      expect(await service.changes(0)).toEqual([
        { path: file, status: 'modified', additions: 1, deletions: 1 },
      ]);
      expect(await service.changes(1)).toEqual([]);
    } finally {
      await ctx.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records a Write-created file as added with its real content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'file-history-e2e-'));
    const file = join(dir, 'fresh.txt');
    const ctx = createTestAgent();
    try {
      await ctx.rpc.setPermission({ mode: 'yolo' });

      const writeCall: ToolCall = {
        type: 'function',
        id: 'call_w1',
        name: 'Write',
        arguments: JSON.stringify({ path: file, content: 'one\ntwo\nthree\n' }),
      };
      ctx.mockNextResponse({ type: 'text', text: 'Writing.' }, writeCall);
      ctx.mockNextResponse({ type: 'text', text: 'Done.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Create the file' }] });
      await ctx.untilTurnEnd();

      ctx.mockNextResponse({ type: 'text', text: 'Idle.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Thanks' }] });
      await ctx.untilTurnEnd();

      const service = ctx.get(IAgentFileHistoryService);
      await service.settled();

      const state = service.history();
      expect(state.checkpoints.find((c) => c.turnId === 0)?.entries[file]).toEqual({
        key: null,
        version: 1,
      });
      expect(await service.changes(0)).toEqual([
        { path: file, status: 'added', additions: 3, deletions: 0 },
      ]);
    } finally {
      await ctx.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('displacedCheckpoints', () => {
  function record(turnId: number, phase: 'start' | 'end') {
    return { turnId, phase, entries: {} };
  }

  it('returns nothing until more than five completed turns exist', () => {
    const checkpoints = [1, 2, 3, 4, 5].flatMap((turn) => [record(turn, 'start'), record(turn, 'end')]);
    expect(displacedCheckpoints(checkpoints)).toEqual([]);
    expect(displacedCheckpoints(checkpoints, 6)).toHaveLength(2);
  });

  it('counts completed turns, not turn ids, so ordinal gaps keep the window full', () => {
    const checkpoints = [1, 4, 9, 12, 20, 31].flatMap((turn) => [record(turn, 'start'), record(turn, 'end')]);
    const displaced = displacedCheckpoints(checkpoints);
    expect(displaced.map((c) => c.turnId)).toEqual([1, 1]);
  });

  it('drops stale start-only turns while sparing anything newer than the latest completed turn', () => {
    const checkpoints = [
      record(1, 'start'),
      ...[2, 3, 4, 5, 6, 7].flatMap((turn) => [record(turn, 'start'), record(turn, 'end')]),
      record(8, 'start'),
    ];
    const displaced = displacedCheckpoints(checkpoints);
    expect(displaced.map((c) => c.turnId)).toEqual([1, 2, 2]);
  });
});

describe('countLineDiff', () => {
  it('counts additions and deletions across a small edit', () => {
    expect(countLineDiff('a\nb\nc\n', 'a\nx\nc\n')).toEqual({ additions: 1, deletions: 1 });
  });

  it('counts a trailing-newline-only change as one changed line', () => {
    expect(countLineDiff('a\n', 'a')).toEqual({ additions: 1, deletions: 1 });
    expect(countLineDiff('a', 'a')).toEqual({ additions: 0, deletions: 0 });
  });

  it('short-circuits identical content without touching the budget', () => {
    const budget = { remaining: 0 };
    expect(countLineDiff('same\n', 'same\n', budget)).toEqual({ additions: 0, deletions: 0 });
  });

  it('returns undefined instead of approximating when the cell budget is exhausted', () => {
    const before = Array.from({ length: 200 }, (_, i) => `left-${String(i)}`).join('\n');
    const after = Array.from({ length: 200 }, (_, i) => `right-${String(i)}`).join('\n');
    const budget = { remaining: 10 };
    expect(countLineDiff(before, after, budget)).toBeUndefined();
    expect(budget.remaining).toBe(10);
  });
});
