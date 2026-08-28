import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { IEventBus, type ISessionEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import type { IFlagService } from '#/app/flag/flag';
import { AgentFileHistoryService } from '#/features/fileHistory/fileHistoryService';
import type { ToolCall } from '#/kosong/contract/message';
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
        hostFs(),
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
