import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
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
      acquire: () => ({ runtime: { fs: hostFs() }, dispose: () => {} }),
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
      ),
    );
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

    startTurn(2);
    await service.settled();
    state = service.history();
    const v2 = state.checkpoints.find((c) => c.turnId === 2)?.entries['a.txt'];
    expect(v2?.version).toBe(2);
    expect(await blobText(v2!.key!)).toBe('one\nTWO\n');

    expect(await service.changes(1)).toEqual([
      { path: 'a.txt', status: 'modified', additions: 1, deletions: 1 },
    ]);
    expect((await service.contentAt(1, 'a.txt'))?.content).toBe('one\ntwo\n');
    expect((await service.contentAt(2, '/ws/a.txt'))?.content).toBe('one\nTWO\n');
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
    startTurn(2);
    startTurn(3);
    await service.settled();

    const state = service.history();
    const entryAtTurn2 = state.checkpoints.find((c) => c.turnId === 2)?.entries['b.txt'];
    const entryAtTurn3 = state.checkpoints.find((c) => c.turnId === 3)?.entries['b.txt'];
    expect(entryAtTurn2?.version).toBe(1);
    expect(entryAtTurn3?.version).toBe(1);
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
    startTurn(2);
    await service.settled();
    expect(await service.changes(1)).toEqual([
      { path: 'new.txt', status: 'added', additions: 1, deletions: 0 },
    ]);

    files.delete('/ws/new.txt');
    startTurn(3);
    await service.settled();
    entry = service.history().checkpoints.find((c) => c.turnId === 3)?.entries['new.txt'];
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
    expect((await service.contentAt(2, 'a.txt'))?.content).toBe('alpha\nagent\nuser\n');
  });

  it('guards reads once the flag is turned off after data was recorded', async () => {
    const service = createService();
    setFile('/ws/a.txt', 'content\n');

    startTurn(1);
    await fireEdit(service, '/ws/a.txt', 1);
    setFile('/ws/a.txt', 'changed\n');
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

  it('keeps over-budget diff approximations non-negative on repetitive files', () => {
    const before = [...Array.from({ length: 3000 }, () => 'dup'), 'end-old'].join('\n');
    const after = ['start-new', ...Array.from({ length: 2100 }, () => 'dup')].join('\n');
    const diff = countLineDiff(before, after);
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(901);
  });

  it('keeps over-budget diff approximations order-aware on reordered files', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line-${String(i)}`);
    const before = [...lines, 'tail-old'].join('\n');
    const after = ['head-new', ...lines.toReversed()].join('\n');
    const diff = countLineDiff(before, after);
    expect(diff.additions).toBeGreaterThan(2000);
    expect(diff.deletions).toBeGreaterThan(2000);
  });

  it('stays inactive on subagents', async () => {
    const service = createService('sub-1');
    setFile('/ws/a.txt', 'content\n');

    startTurn(1);
    await fireEdit(service, '/ws/a.txt', 1);
    await service.settled();

    expect(service.history().checkpoints).toEqual([]);
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
      const checkpoint1 = state.checkpoints.find((c) => c.turnId === 0);
      const checkpoint2 = state.checkpoints.find((c) => c.turnId === 1);
      expect(checkpoint1?.entries[file]?.version).toBe(1);
      expect(checkpoint2?.entries[file]?.version).toBe(2);

      expect((await service.contentAt(0, file))?.content).toBe('alpha\nbeta\n');
      expect((await service.contentAt(1, file))?.content).toBe('alpha\ndelta\n');

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
