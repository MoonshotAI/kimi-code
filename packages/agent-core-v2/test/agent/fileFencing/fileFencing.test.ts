/**
 * `fileFencing` domain (L4) — verifies the write/read-first gate end to end
 * through the real DI scope tree: a real tmpdir, the real `HostFileSystem`,
 * the real watch service folding fake os-watcher events, and the registered
 * `writeFencing` hook participant over a real `OrderedHookSlot`. Covers both
 * flag postures (`multi_server` on = hard block, off = advisory note), the
 * own-write echo / truncated-window stale checks, out-of-root stat fallback,
 * watched-root ensuring for additional dirs, and ledger isolation between
 * two Session scopes sharing one workspace (two-instance conflict).
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LifecycleScope, type Scope } from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { IAgentFileFencingService } from '#/agent/fileFencing/fileFencing';
import { AgentFileFencingService } from '#/agent/fileFencing/fileFencingService';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  ToolBeforeExecuteContext,
  ToolDidExecuteContext,
} from '#/agent/toolExecutor/toolHooks';
import { IFlagService } from '#/app/flag/flag';
import type { ToolCall } from '#/app/llmProtocol/message';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionFileLedger } from '#/session/sessionFileLedger/fileLedger';
import { SessionFileLedger } from '#/session/sessionFileLedger/fileLedgerService';
import { ISessionFsWatchService } from '#/session/sessionFs/fsWatch';
import { SessionFsWatchService } from '#/session/sessionFs/fsWatchService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { SessionWorkspaceContextService } from '#/session/workspaceContext/workspaceContextService';
import {
  ToolAccesses,
  type ExecutableToolResult,
  makeToolFileRevision,
  toolFileRevision,
} from '#/tool/toolContract';

import { AgentToolExecutorService } from '#/agent/toolExecutor/toolExecutorService';

import { stubToolExecutor } from '../loop/stubs';
import { fakeHostFsWatch, type FakeWatch } from '../../session/sessionFs/stubs';

void AgentFileFencingService;
void SessionFileLedger;
void SessionFsWatchService;
void SessionWorkspaceContextService;
void AgentToolExecutorService;

let multiServer = false;

function countingHostFs(): { fs: IHostFileSystem; statCalls: () => number } {
  const real = new HostFileSystem();
  let count = 0;
  const fs = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'stat') {
        return async (path: string) => {
          count += 1;
          return target.stat(path);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as IHostFileSystem;
  return { fs, statCalls: () => count };
}

interface Env {
  readonly host: ScopedTestHost;
  readonly fake: FakeWatch;
  readonly workDir: string;
  readonly outsideDir: string;
  readonly statCalls: () => number;
}

function makeEnv(): Env {
  const workDir = mkdtempSync(join(tmpdir(), 'kimi-fencing-work-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'kimi-fencing-out-'));
  cleanupPaths.push(workDir, outsideDir);
  const fake = fakeHostFsWatch();
  const { fs, statCalls } = countingHostFs();
  const host = createScopedTestHost([
    stubPair(IHostFileSystem, fs),
    stubPair(IHostFsWatchService, fake.service),
    stubPair(IFlagService, {
      _serviceBrand: undefined,
      enabled: () => multiServer,
    } as unknown as IFlagService),
  ]);
  hosts.push(host);
  return { host, fake, workDir, outsideDir, statCalls };
}

function makeSession(env: Env, sessionId: string, cwd: string): Scope {
  return env.host.child(LifecycleScope.Session, sessionId, [
    stubPair(
      ISessionContext,
      makeSessionContext({
        sessionId,
        workspaceId: 'ws',
        sessionDir: join(cwd, '.session'),
        sessionScope: `sessions/ws/${sessionId}`,
        cwd,
      }),
    ),
  ]);
}

interface AgentWorld {
  readonly env: Env;
  readonly session: Scope;
  readonly agent: Scope;
  readonly executor: IAgentToolExecutorService;
  readonly watch: ISessionFsWatchService;
  readonly workspace: ISessionWorkspaceContext;
}

function makeAgent(env: Env, session: Scope): AgentWorld {
  const executor = stubToolExecutor();
  const agent = env.host.childOf(session, LifecycleScope.Agent, 'main', [
    stubPair(IAgentToolExecutorService, executor),
  ]);
  agent.accessor.get(IAgentFileFencingService);
  session.accessor.get(ISessionFileLedger);
  return {
    env,
    session,
    agent,
    executor,
    watch: session.accessor.get(ISessionFsWatchService),
    workspace: session.accessor.get(ISessionWorkspaceContext),
  };
}

function setup(): AgentWorld {
  const env = makeEnv();
  return makeAgent(env, makeSession(env, 's1', env.workDir));
}

let nextCallSeq = 0;

function beforeCtx(
  toolName: string,
  path: string,
  opts: { id?: string; turnId?: number; args?: Record<string, unknown> } = {},
): ToolBeforeExecuteContext {
  const id = opts.id ?? `call-${++nextCallSeq}`;
  const args =
    opts.args ??
    (toolName === 'Edit'
      ? { path, old_string: 'a', new_string: 'b' }
      : toolName === 'Write'
        ? { path, content: 'x' }
        : { path });
  const toolCall: ToolCall = {
    type: 'function',
    id,
    name: toolName,
    arguments: JSON.stringify(args),
  };
  const operation = toolName === 'Read' ? 'read' : toolName === 'Write' ? 'write' : 'readwrite';
  return {
    turnId: opts.turnId ?? 1,
    signal: new AbortController().signal,
    toolCall,
    toolCalls: [toolCall],
    args,
    execution: {
      accesses: ToolAccesses.file(operation, path),
      approvalRule: toolName,
      execute: async () => ({ output: 'ok' }),
    },
  };
}

async function runBefore(
  world: AgentWorld,
  ctx: ToolBeforeExecuteContext,
): Promise<ToolBeforeExecuteContext> {
  await world.executor.hooks.onBeforeExecuteTool.run(ctx);
  await runPrepared(ctx);
  return ctx;
}

async function runPrepared(ctx: ToolBeforeExecuteContext): Promise<void> {
  if (ctx.decision?.execute === undefined) return;
  await ctx.decision.execute({
    turnId: ctx.turnId,
    toolCallId: ctx.toolCall.id,
    trace: ctx.trace,
    signal: ctx.signal,
  });
}

async function runDid(
  world: AgentWorld,
  ctx: ToolBeforeExecuteContext,
  result?: ExecutableToolResult,
): Promise<ToolDidExecuteContext> {
  let effectiveResult = result;
  if (effectiveResult === undefined) {
    const target = ctx.execution.accesses?.find((access) => access.kind === 'file');
    if (target === undefined || !['Read', 'Write', 'Edit'].includes(ctx.toolCall.name)) {
      effectiveResult = { output: 'done' };
    } else {
      let stat;
      try {
        stat = statSync(target.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        stat = { size: 0 };
      }
      effectiveResult = {
        output: 'done',
        [toolFileRevision]: makeToolFileRevision(target.path, stat),
      };
    }
  }
  const did: ToolDidExecuteContext = {
    turnId: ctx.turnId,
    signal: ctx.signal,
    toolCall: ctx.toolCall,
    toolCalls: [ctx.toolCall],
    args: ctx.args,
    result: effectiveResult,
  };
  await world.executor.hooks.onDidExecuteTool.run(did);
  return did;
}

async function runOk(
  world: AgentWorld,
  toolName: string,
  path: string,
  opts: { id?: string; turnId?: number; args?: Record<string, unknown> } = {},
): Promise<ToolDidExecuteContext> {
  const ctx = await runBefore(world, beforeCtx(toolName, path, opts));
  expect(ctx.decision?.block).not.toBe(true);
  if (toolName === 'Write') {
    const args = ctx.args as { readonly content: string; readonly mode?: 'overwrite' | 'append' };
    writeFileSync(path, args.content, { flag: args.mode === 'append' ? 'a' : 'w' });
  }
  return runDid(world, ctx);
}

function foldChange(world: AgentWorld, rel: string, action: 'created' | 'modified' | 'deleted'): void {
  world.env.fake.fire(rel, action);
  vi.advanceTimersByTime(200);
}

function foldJunk(env: Env, count = 501): void {
  for (let i = 0; i < count; i++) env.fake.fire(`junk-${i}.tmp`, 'created');
  vi.advanceTimersByTime(200);
}

const hosts: ScopedTestHost[] = [];
const cleanupPaths: string[] = [];

describe('AgentFileFencingService', () => {
  beforeEach(() => {
    multiServer = false;
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
    for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
    vi.useRealTimers();
  });

  describe('with the multi_server flag on', () => {
    it('blocks Edit on an existing file that was never read, read-first', async () => {
      multiServer = true;
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, 'hello');

      const ctx = await runBefore(world, beforeCtx('Edit', file));
      expect(ctx.decision?.block).toBe(true);
      expect(ctx.decision?.reason).toContain('has not been read in this session');
      expect(ctx.decision?.reason).toContain('Read it first');
    });

    it('blocks Edit when the file changed on disk since the last read, and unblocks after re-read', async () => {
      multiServer = true;
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, 'hello');
      await runOk(world, 'Read', file);

      writeFileSync(file, 'hello world');
      foldChange(world, 'a.txt', 'modified');

      const ctx = await runBefore(world, beforeCtx('Edit', file));
      expect(ctx.decision?.block).toBe(true);
      expect(ctx.decision?.reason).toContain('changed on disk since');

      await runOk(world, 'Read', file);
      const retry = await runBefore(world, beforeCtx('Edit', file));
      expect(retry.decision?.block).not.toBe(true);
    });

    it('checks the file at execution time rather than during preflight', async () => {
      multiServer = true;
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, 'hello');
      await runOk(world, 'Read', file);

      const ctx = beforeCtx('Edit', file);
      await world.executor.hooks.onBeforeExecuteTool.run(ctx);
      writeFileSync(file, 'changed while queued');

      await runPrepared(ctx);
      expect(ctx.decision?.block).toBe(true);
      expect(ctx.decision?.reason).toContain('changed on disk since');
    });

    it('keeps the revision captured by Read when the file changes before the did-hook', async () => {
      multiServer = true;
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, 'hello');
      const ctx = await runBefore(world, beforeCtx('Read', file));
      const readRevision = makeToolFileRevision(file, statSync(file));

      writeFileSync(file, 'changed after read');
      await runDid(world, ctx, {
        output: 'hello',
        [toolFileRevision]: readRevision,
      });

      const edit = await runBefore(world, beforeCtx('Edit', file));
      expect(edit.decision?.block).toBe(true);
      expect(edit.decision?.reason).toContain('changed on disk since');
    });

    it('wraps an execution override installed by an earlier hook', async () => {
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, 'hello');
      await runOk(world, 'Read', file);
      let overrideCalls = 0;
      const ctx = beforeCtx('Edit', file);
      ctx.decision = {
        execute: async () => {
          overrideCalls++;
          return { output: 'overridden' };
        },
      };

      await world.executor.hooks.onBeforeExecuteTool.run(ctx);
      await runPrepared(ctx);

      expect(overrideCalls).toBe(1);
    });

    it('blocks Write over an existing file that was never read', async () => {
      multiServer = true;
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, 'hello');

      const ctx = await runBefore(world, beforeCtx('Write', file));
      expect(ctx.decision?.block).toBe(true);
      expect(ctx.decision?.reason).toContain('already exists');
      expect(ctx.decision?.reason).toContain('has not been read in this session');
    });

    it('allows Write creating a new file and baselines it', async () => {
      multiServer = true;
      const world = setup();
      const file = join(world.env.workDir, 'new.txt');

      await runOk(world, 'Write', file);
      const ctx = await runBefore(world, beforeCtx('Edit', file));
      expect(ctx.decision?.block).not.toBe(true);
    });

    it('allows Edit right after a full Read', async () => {
      multiServer = true;
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, 'hello');

      await runOk(world, 'Read', file);
      const ctx = await runBefore(world, beforeCtx('Edit', file));
      expect(ctx.decision?.block).not.toBe(true);
    });

    it('allows consecutive Edits without watcher events', async () => {
      multiServer = true;
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, 'hello');

      await runOk(world, 'Read', file);
      await runOk(world, 'Edit', file);
      const ctx = await runBefore(world, beforeCtx('Edit', file));
      expect(ctx.decision?.block).not.toBe(true);
    });

    it('keeps consecutive Edits clean through the own-write watcher echo and re-baselines', async () => {
      multiServer = true;
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, 'hello');
      await runOk(world, 'Read', file);
      expect(world.env.statCalls()).toBe(0);

      foldChange(world, 'a.txt', 'modified');

      const ctx = await runBefore(world, beforeCtx('Edit', file));
      expect(ctx.decision?.block).not.toBe(true);
      expect(world.env.statCalls()).toBe(1);

      const again = await runBefore(world, beforeCtx('Edit', file));
      expect(again.decision?.block).not.toBe(true);
      expect(world.env.statCalls()).toBe(2);
    });

    it('resolves a truncated window by stat punch: unchanged passes, changed blocks', async () => {
      multiServer = true;
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, 'hello');
      await runOk(world, 'Read', file);

      foldJunk(world.env);

      const unchanged = await runBefore(world, beforeCtx('Edit', file));
      expect(unchanged.decision?.block).not.toBe(true);

      writeFileSync(file, 'hello world');
      foldJunk(world.env);

      const changed = await runBefore(world, beforeCtx('Edit', file));
      expect(changed.decision?.block).toBe(true);
      expect(changed.decision?.reason).toContain('changed on disk since');
    });

    it('blocks ranged-Read followed by Edit because ranged reads never baseline', async () => {
      multiServer = true;
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, '1\n2\n3\n4\n5\n6\n');

      await runOk(world, 'Read', file, { args: { path: file, line_offset: 5 } });
      const ctx = await runBefore(world, beforeCtx('Edit', file));
      expect(ctx.decision?.block).toBe(true);
      expect(ctx.decision?.reason).toContain('has not been read in this session');
    });

    it('blocks out-of-root writes through the stat-only fallback and allows them after Read', async () => {
      multiServer = true;
      const world = setup();
      const file = join(world.env.outsideDir, 'b.txt');
      writeFileSync(file, 'hello');

      const first = await runBefore(world, beforeCtx('Edit', file));
      expect(first.decision?.block).toBe(true);
      expect(first.decision?.reason).toContain('has not been read in this session');

      await runOk(world, 'Read', file);
      const afterRead = await runBefore(world, beforeCtx('Edit', file));
      expect(afterRead.decision?.block).not.toBe(true);

      writeFileSync(file, 'hello world');
      const changed = await runBefore(world, beforeCtx('Edit', file));
      expect(changed.decision?.block).toBe(true);
      expect(changed.decision?.reason).toContain('changed on disk since');
    });

    it('ensures an additional dir becomes watched when a write target falls under it', async () => {
      multiServer = true;
      const world = setup();
      world.workspace.addAdditionalDir(world.env.outsideDir);
      const file = join(world.env.outsideDir, 'new.txt');

      await runOk(world, 'Write', file);
      expect(world.watch.watchedRoots).toContain(world.env.outsideDir);
      expect(world.env.fake.watchCalls).toContain(world.env.outsideDir);

      writeFileSync(file, 'changed outside');
      world.env.fake.handles
        .find((h) => h.root === world.env.outsideDir)
        ?.fire('new.txt', 'modified');
      vi.advanceTimersByTime(200);

      const ctx = await runBefore(world, beforeCtx('Write', file));
      expect(ctx.decision?.block).toBe(true);
      expect(ctx.decision?.reason).toContain('changed on disk since');
    });

    it('keeps ledgers on two session scopes sharing one workspace independent and flags the peer change', async () => {
      multiServer = true;
      const env = makeEnv();
      const worldA = makeAgent(env, makeSession(env, 'sA', env.workDir));
      const worldB = makeAgent(env, makeSession(env, 'sB', env.workDir));
      const file = join(env.workDir, 'a.txt');
      writeFileSync(file, 'hello');

      await runOk(worldA, 'Read', file);

      const neverRead = await runBefore(worldB, beforeCtx('Edit', file));
      expect(neverRead.decision?.block).toBe(true);
      expect(neverRead.decision?.reason).toContain('has not been read in this session');

      writeFileSync(file, 'hello world');
      env.fake.handles
        .findLast((h) => h.root === env.workDir)
        ?.fire('a.txt', 'modified');
      vi.advanceTimersByTime(200);

      const conflict = await runBefore(worldB, beforeCtx('Edit', file));
      expect(conflict.decision?.block).toBe(true);
      expect(conflict.decision?.reason).toContain('changed on disk since');
    });
  });

  describe('with the multi_server flag off', () => {
    it('admits Edit on an unread existing file with an advisory, then re-baselines', async () => {
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, 'hello');

      const did = await runOk(world, 'Edit', file);
      expect(did.result.note).toContain('<system>Warning:');
      expect(did.result.note).toContain('had not been read in this session');

      const second = await runOk(world, 'Edit', file);
      expect(second.result.note).toBeUndefined();
    });

    it('admits Write over an unread existing file with an advisory', async () => {
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, 'hello');

      const did = await runOk(world, 'Write', file);
      expect(did.result.note).toContain('already existed on disk');
    });

    it('admits Edit after an outside change with the applied-anyway advisory', async () => {
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, 'hello');
      await runOk(world, 'Read', file);

      writeFileSync(file, 'hello world');
      foldChange(world, 'a.txt', 'modified');

      const did = await runOk(world, 'Edit', file);
      expect(did.result.note).toContain('changed on disk since it was last read in this session');
      expect(did.result.note).toContain('your change was applied anyway');

      const second = await runOk(world, 'Edit', file);
      expect(second.result.note).toBeUndefined();
    });

    it('composes the advisory with an existing result note', async () => {
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, 'hello');

      const ctx = await runBefore(world, beforeCtx('Edit', file));
      const did = await runDid(world, ctx, { output: 'done', note: '<system>existing</system>' });
      expect(did.result.note).toBe(
        '<system>existing</system>\n' +
          `<system>Warning: "${file}" already existed on disk and had not been read in this session; ` +
          'your change overwrote it anyway. Read the file to verify the current content.</system>',
      );
    });

    it('never advisories direct creation of a new file', async () => {
      const world = setup();
      const did = await runOk(world, 'Write', join(world.env.workDir, 'new.txt'));
      expect(did.result.note).toBeUndefined();
    });

    it('adds no advisory and no baseline when the tool result is an error', async () => {
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, 'hello');
      await runOk(world, 'Read', file);

      writeFileSync(file, 'hello world');
      foldChange(world, 'a.txt', 'modified');

      const failed = await runBefore(world, beforeCtx('Edit', file));
      const failedDid = await runDid(world, failed, { output: 'boom', isError: true });
      expect(failedDid.result.note).toBeUndefined();

      const retry = await runOk(world, 'Edit', file);
      expect(retry.result.note).toContain('changed on disk since it was last read in this session');
    });

    it('does not leak a stale mark across turns', async () => {
      const world = setup();
      const file = join(world.env.workDir, 'a.txt');
      writeFileSync(file, 'hello');

      await runBefore(world, beforeCtx('Edit', file, { id: 'call-abandoned', turnId: 1 }));
      await runBefore(
        world,
        beforeCtx('Edit', join(world.env.workDir, 'other.txt'), { turnId: 2 }),
      );

      const abandonedCtx = beforeCtx('Edit', file, { id: 'call-abandoned', turnId: 1 });
      const did = await runDid(world, abandonedCtx);
      expect(did.result.note).toBeUndefined();
    });

    it('ignores tools other than Read/Write/Edit entirely', async () => {
      const world = setup();
      const ctx = await runBefore(
        world,
        beforeCtx('Bash', join(world.env.workDir, 'a.txt'), { args: { command: 'ls' } }),
      );
      expect(ctx.decision).toBeUndefined();

      const did = await runDid(world, ctx);
      expect(did.result.note).toBeUndefined();
      expect(world.env.statCalls()).toBe(0);
    });
  });
});
