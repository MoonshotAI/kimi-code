import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  BeforeToolExecuteEvent,
  ToolDidExecuteContext,
} from '#/agent/toolExecutor/toolHooks';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import type { ToolCall } from '#/kosong/contract/message';
import { IStaleGuardService } from '#/features/staleGuard/staleGuard';
import { StaleGuardService } from '#/features/staleGuard/staleGuardService';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { ToolAccesses, type ExecutableToolResult } from '#/tool/toolContract';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';

import { createTestAgent } from '../../harness';
import { stubWireJournal } from '../../wire/stubs';

const noopBlob: IAgentBlobService = {
  _serviceBrand: undefined,
  offloadParts: async (parts) => parts,
  loadParts: async (parts) => parts,
  isBlobRef: () => false,
};

interface CapturedHooks {
  readonly before: ((event: BeforeToolExecuteEvent) => unknown)[];
  readonly did: ((ctx: ToolDidExecuteContext, next: () => Promise<void>) => Promise<void>)[];
}

function stubToolExecutor(captured: CapturedHooks): IAgentToolExecutorService {
  return {
    _serviceBrand: undefined,
    onBeforeExecuteTool: (listener: (event: BeforeToolExecuteEvent) => unknown) => {
      captured.before.push(listener);
      return toDisposable(() => {});
    },
    hooks: {
      onDidExecuteTool: {
        register: (
          _name: string,
          handler: (ctx: ToolDidExecuteContext, next: () => Promise<void>) => Promise<void>,
        ) => {
          captured.did.push(handler);
          return toDisposable(() => {});
        },
      },
    },
  } as unknown as IAgentToolExecutorService;
}

let activeFs: IHostFileSystem;
let fireRuntimeChange: () => void = () => {};

function stubRuntime(): IAgentRuntimeService {
  return {
    _serviceBrand: undefined,
    onDidChange: (listener: () => void) => {
      fireRuntimeChange = listener;
      return toDisposable(() => {});
    },
    acquire: () => ({
      runtime: { fs: activeFs },
      track: (resource: unknown) => resource,
      dispose: () => {},
    }),
  } as unknown as IAgentRuntimeService;
}

function stubFs(stat: Partial<HostFileStat> | Error): IHostFileSystem {
  return {
    _serviceBrand: undefined,
    stat: async () => {
      if (stat instanceof Error) throw stat;
      return { isFile: true, isDirectory: false, size: 0, ...stat };
    },
  } as unknown as IHostFileSystem;
}

function enoent(): Error {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
}

function outputText(result: ExecutableToolResult | undefined): string {
  const output = result?.output;
  if (typeof output !== 'string') throw new TypeError('expected string output');
  return output;
}

async function runBeforeExecute(
  captured: CapturedHooks,
  input: { name: string; args?: unknown; accesses?: ToolAccesses; batch?: ToolCall[] },
): Promise<ExecutableToolResult | undefined> {
  const pending: (() => Promise<BeforeExecuteDecision | undefined>)[] = [];
  let veto: ExecutableToolResult | undefined;
  const toolCall = {
    type: 'function',
    id: 'call_1',
    name: input.name,
    arguments: JSON.stringify(input.args ?? {}),
  } as ToolCall;
  const event = {
    turnId: 0,
    signal: new AbortController().signal,
    toolCall,
    toolCalls: input.batch ?? [toolCall],
    args: input.args,
    execution: { accesses: input.accesses },
    veto: (result: ExecutableToolResult) => {
      veto = result;
    },
    allow: () => {},
    pass: () => {},
    waitUntil: (factory: () => Promise<BeforeExecuteDecision | undefined>) => {
      pending.push(factory);
    },
  } as unknown as BeforeToolExecuteEvent;
  for (const listener of captured.before) await listener(event);
  for (const factory of pending) {
    const decision = await factory();
    if (decision?.veto !== undefined) veto = decision.veto;
  }
  return veto;
}

async function runDidExecute(
  captured: CapturedHooks,
  input: { name: string; accesses?: ToolAccesses; isError?: boolean },
): Promise<void> {
  const ctx = {
    turnId: 0,
    signal: new AbortController().signal,
    toolCall: { id: 'call_1', name: input.name },
    toolCalls: [],
    args: {},
    outcome: 'executed',
    accesses: input.accesses,
    result: input.isError === true ? { output: 'failed', isError: true } : { output: 'ok' },
  } as unknown as ToolDidExecuteContext;
  for (const handler of captured.did) await handler(ctx, async () => {});
}

describe('StaleGuardService', () => {
  let disposables: DisposableStore;
  let records: WireRecord[];
  let hooks: CapturedHooks;
  let freshness: IStaleGuardService;

  function buildStack(journal: WireRecord[]): {
    freshness: IStaleGuardService;
    dispatcher: IEventDispatcher;
    hooks: CapturedHooks;
  } {
    const captured: CapturedHooks = { before: [], did: [] };
    const ix = disposables.add(new TestInstantiationService());
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.set(IAgentBlobService, noopBlob);
    ix.set(IWireService, stubWireJournal(journal));
    ix.set(IAgentStateService, new AgentStateService());
    ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
    ix.set(IAgentToolExecutorService, stubToolExecutor(captured));
    ix.set(IAgentRuntimeService, stubRuntime());
    ix.set(IStaleGuardService, new SyncDescriptor(StaleGuardService));
    return {
      freshness: ix.get(IStaleGuardService),
      dispatcher: ix.get(IEventDispatcher),
      hooks: captured,
    };
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    records = [];
    activeFs = stubFs({});
    const stack = buildStack(records);
    hooks = stack.hooks;
    freshness = stack.freshness;
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('records the mtime of a successfully read file into state and the wire journal', async () => {
    activeFs = stubFs({ mtimeMs: 111 });

    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });

    expect(freshness.recordedMtimeMs('/tmp/a.txt')).toBe(111);
    expect(records).toEqual([
      { type: 'staleGuard.recorded', path: '/tmp/a.txt', mtimeMs: 111, time: expect.any(Number) },
    ]);
  });

  it('does not record when the read failed', async () => {
    activeFs = stubFs({ mtimeMs: 111 });

    await runDidExecute(hooks, {
      name: 'Read',
      accesses: ToolAccesses.readFile('/tmp/a.txt'),
      isError: true,
    });

    expect(freshness.recordedMtimeMs('/tmp/a.txt')).toBeUndefined();
    expect(records).toEqual([]);
  });

  it('ignores tools without file semantics', async () => {
    const veto = await runBeforeExecute(hooks, { name: 'Bash', args: { command: 'ls' } });
    expect(veto).toBeUndefined();

    activeFs = stubFs({ mtimeMs: 111 });
    await runDidExecute(hooks, { name: 'Bash' });
    expect(records).toEqual([]);
  });

  it('vetoes editing an existing file the agent never read', async () => {
    activeFs = stubFs({ mtimeMs: 5 });

    const veto = await runBeforeExecute(hooks, {
      name: 'Edit',
      args: { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
      accesses: ToolAccesses.readWriteFile('/tmp/a.txt'),
    });

    expect(veto?.isError).toBe(true);
    expect(outputText(veto)).toContain('has not been read');
    expect(outputText(veto)).toContain('/tmp/a.txt');
  });

  it('allows the write when the on-disk mtime matches the last read', async () => {
    activeFs = stubFs({ mtimeMs: 111 });
    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });

    const veto = await runBeforeExecute(hooks, {
      name: 'Write',
      args: { path: '/tmp/a.txt', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/a.txt'),
    });

    expect(veto).toBeUndefined();
  });

  it('vetoes the write when the file changed on disk since the last read', async () => {
    activeFs = stubFs({ mtimeMs: 111 });
    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });
    activeFs = stubFs({ mtimeMs: 222 });

    const veto = await runBeforeExecute(hooks, {
      name: 'Edit',
      args: { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
      accesses: ToolAccesses.readWriteFile('/tmp/a.txt'),
    });

    expect(veto?.isError).toBe(true);
    expect(outputText(veto)).toContain('modified on disk');
  });

  it('allows a write covered by an earlier Read of the same path in the same batch', async () => {
    activeFs = stubFs({ mtimeMs: 5 });
    const readCall: ToolCall = {
      type: 'function',
      id: 'call_0',
      name: 'Read',
      arguments: JSON.stringify({ path: '/tmp/a.txt' }),
    };
    const writeCall: ToolCall = {
      type: 'function',
      id: 'call_1',
      name: 'Write',
      arguments: JSON.stringify({ path: '/tmp/a.txt', content: 'x' }),
    };

    const veto = await runBeforeExecute(hooks, {
      name: 'Write',
      args: { path: '/tmp/a.txt', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/a.txt'),
      batch: [readCall, writeCall],
    });

    expect(veto).toBeUndefined();
  });

  it('still vetoes when the earlier batch Read targets a different path', async () => {
    activeFs = stubFs({ mtimeMs: 5 });
    const readCall: ToolCall = {
      type: 'function',
      id: 'call_0',
      name: 'Read',
      arguments: JSON.stringify({ path: '/tmp/other.txt' }),
    };
    const writeCall: ToolCall = {
      type: 'function',
      id: 'call_1',
      name: 'Write',
      arguments: JSON.stringify({ path: '/tmp/a.txt', content: 'x' }),
    };

    const veto = await runBeforeExecute(hooks, {
      name: 'Write',
      args: { path: '/tmp/a.txt', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/a.txt'),
      batch: [readCall, writeCall],
    });

    expect(veto?.isError).toBe(true);
    expect(outputText(veto)).toContain('has not been read');
  });

  it('clears recorded mtimes when the runtime changes', async () => {
    activeFs = stubFs({ mtimeMs: 111 });
    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });
    expect(freshness.recordedMtimeMs('/tmp/a.txt')).toBe(111);

    fireRuntimeChange();

    expect(freshness.recordedMtimeMs('/tmp/a.txt')).toBeUndefined();
    expect(records).toContainEqual({
      type: 'staleGuard.cleared',
      time: expect.any(Number),
    });
    const veto = await runBeforeExecute(hooks, {
      name: 'Edit',
      args: { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
      accesses: ToolAccesses.readWriteFile('/tmp/a.txt'),
    });
    expect(outputText(veto)).toContain('has not been read');
  });

  it('allows writing a file that does not exist yet', async () => {
    activeFs = stubFs(enoent());

    const veto = await runBeforeExecute(hooks, {
      name: 'Write',
      args: { path: '/tmp/new.txt', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/new.txt'),
    });

    expect(veto).toBeUndefined();
  });

  it('skips the check when the runtime stat carries no mtimeMs', async () => {
    activeFs = stubFs({});

    const veto = await runBeforeExecute(hooks, {
      name: 'Edit',
      args: { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
      accesses: ToolAccesses.readWriteFile('/tmp/a.txt'),
    });

    expect(veto).toBeUndefined();
  });

  it('skips the check when the path is not a regular file', async () => {
    activeFs = stubFs({ isFile: false, isDirectory: true, mtimeMs: 5 });

    const veto = await runBeforeExecute(hooks, {
      name: 'Write',
      args: { path: '/tmp/dir', content: 'x' },
      accesses: ToolAccesses.writeFile('/tmp/dir'),
    });

    expect(veto).toBeUndefined();
  });

  it('refreshes the record after a successful write so consecutive writes are not blocked', async () => {
    activeFs = stubFs({ mtimeMs: 111 });
    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });

    activeFs = stubFs({ mtimeMs: 222 });
    await runDidExecute(hooks, { name: 'Edit', accesses: ToolAccesses.readWriteFile('/tmp/a.txt') });

    expect(freshness.recordedMtimeMs('/tmp/a.txt')).toBe(222);
    const veto = await runBeforeExecute(hooks, {
      name: 'Edit',
      args: { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
      accesses: ToolAccesses.readWriteFile('/tmp/a.txt'),
    });
    expect(veto).toBeUndefined();
  });

  it('rebuilds recorded mtimes from the wire journal on restore', async () => {
    activeFs = stubFs({ mtimeMs: 111 });
    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });

    const replayed = buildStack([...records]);
    await replayed.dispatcher.restore();

    expect(replayed.freshness.recordedMtimeMs('/tmp/a.txt')).toBe(111);
    activeFs = stubFs({ mtimeMs: 999 });
    const veto = await runBeforeExecute(replayed.hooks, {
      name: 'Edit',
      args: { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
      accesses: ToolAccesses.readWriteFile('/tmp/a.txt'),
    });
    expect(outputText(veto)).toContain('modified on disk');
  });

  it('keeps records isolated between independent agent stacks', async () => {
    activeFs = stubFs({ mtimeMs: 111 });
    await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile('/tmp/a.txt') });

    const other = buildStack([]);

    expect(other.freshness.recordedMtimeMs('/tmp/a.txt')).toBeUndefined();
    const veto = await runBeforeExecute(other.hooks, {
      name: 'Edit',
      args: { path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
      accesses: ToolAccesses.readWriteFile('/tmp/a.txt'),
    });
    expect(outputText(veto)).toContain('has not been read');
  });

  it('detects an external mtime change through the real filesystem', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'file-freshness-'));
    const file = join(dir, 'a.txt');
    await writeFile(file, 'one', 'utf8');
    try {
      activeFs = new HostFileSystem();
      await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile(file) });

      const past = new Date(Date.now() - 60_000);
      await utimes(file, past, past);

      const veto = await runBeforeExecute(hooks, {
        name: 'Edit',
        args: { path: file, old_string: 'one', new_string: 'two' },
        accesses: ToolAccesses.readWriteFile(file),
      });
      expect(outputText(veto)).toContain('modified on disk');

      await runDidExecute(hooks, { name: 'Read', accesses: ToolAccesses.readFile(file) });
      const allowed = await runBeforeExecute(hooks, {
        name: 'Edit',
        args: { path: file, old_string: 'one', new_string: 'two' },
        accesses: ToolAccesses.readWriteFile(file),
      });
      expect(allowed).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('StaleGuardService in the agent test harness', () => {
  it('is assembled by the feature seam with no manual registration', async () => {
    const ctx = createTestAgent();
    try {
      const svc = ctx.get(IStaleGuardService);
      expect(svc).toBeDefined();
      expect(typeof svc.recordedMtimeMs).toBe('function');
    } finally {
      await ctx.dispose();
    }
  });

  it('rejects an Edit with a stale-mtime error after an external modification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'file-freshness-e2e-'));
    const file = join(dir, 'a.txt');
    await writeFile(file, 'alpha beta', 'utf8');
    const ctx = createTestAgent();
    try {
      await ctx.rpc.setPermission({ mode: 'yolo' });

      const readCall: ToolCall = {
        type: 'function',
        id: 'call_read',
        name: 'Read',
        arguments: JSON.stringify({ path: file }),
      };
      ctx.mockNextResponse({ type: 'text', text: 'Reading the file.' }, readCall);
      ctx.mockNextResponse({ type: 'text', text: 'Read complete.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Read the file' }] });
      await ctx.untilTurnEnd();

      const past = new Date(Date.now() - 60_000);
      await utimes(file, past, past);

      const editCall: ToolCall = {
        type: 'function',
        id: 'call_edit',
        name: 'Edit',
        arguments: JSON.stringify({ path: file, old_string: 'beta', new_string: 'gamma' }),
      };
      ctx.mockNextResponse({ type: 'text', text: 'Editing the file.' }, editCall);
      ctx.mockNextResponse({ type: 'text', text: 'Done.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Edit the file' }] });
      await ctx.untilTurnEnd();

      expect(toolResultText(ctx.llmCalls.at(-1)!.history)).toContain('modified on disk');
      expect(await readFile(file, 'utf8')).toBe('alpha beta');
    } finally {
      await ctx.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function toolResultText(history: readonly { role: string; content: readonly unknown[] }[]): string {
  return history
    .filter((message) => message.role === 'tool')
    .flatMap((message) => message.content)
    .map((part) => {
      if (
        part !== null &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text'
      ) {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('\n');
}
