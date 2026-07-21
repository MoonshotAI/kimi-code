/**
 * `fileFencing` domain (L4) — verifies the write/read-first gate end to end
 * through the real DI scope tree: a real tmpdir, the real `HostFileSystem`,
 * the real watch service folding fake os-watcher events, and the registered
 * `writeFencing` hook participant over a real `OrderedHookSlot`. Covers the
 * hard-block verdicts (stale outside change / never-read existing file), the
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
import { stubFlag } from '../../app/flag/stubs';
import { fakeHostFsWatch, type FakeWatch } from '../../session/sessionFs/stubs';

void AgentFileFencingService;
void SessionFileLedger;
void SessionFsWatchService;
void SessionWorkspaceContextService;
void AgentToolExecutorService;

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
    stubPair(IFlagService, stubFlag(false)),
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

async function runPrepared(
  ctx: ToolBeforeExecuteContext,
): Promise<ExecutableToolResult | undefined> {
  if (ctx.decision?.execute === undefined) return undefined;
  return ctx.decision.execute({
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
  const ctx = beforeCtx(toolName, path, opts);
  await world.executor.hooks.onBeforeExecuteTool.run(ctx);
  const prepared = await runPrepared(ctx);
  expect(prepared?.isError).not.toBe(true);
  if (toolName === 'Write') {
    const args = ctx.args as { readonly content: string; readonly mode?: 'overwrite' | 'append' };
    writeFileSync(path, args.content, { flag: args.mode === 'append' ? 'a' : 'w' });
  }
  return runDid(world, ctx);
}

async function runBlocked(
  world: AgentWorld,
  toolName: string,
  path: string,
): Promise<ExecutableToolResult> {
  const ctx = beforeCtx(toolName, path);
  await world.executor.hooks.onBeforeExecuteTool.run(ctx);
  const result = await runPrepared(ctx);
  if (result?.isError !== true) {
    throw new Error(`expected ${toolName} on ${path} to be blocked, got: ${JSON.stringify(result)}`);
  }
  return result;
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
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
    for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('blocks Edit on an existing file that was never read, read-first', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, 'hello');

    const blocked = await runBlocked(world, 'Edit', file);
    expect(blocked.output).toContain('has not been read in this session');
    expect(blocked.output).toContain('Read it first');
  });

  it('blocks Edit when the file changed on disk since the last read, and unblocks after re-read', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await runOk(world, 'Read', file);

    writeFileSync(file, 'hello world');
    foldChange(world, 'a.txt', 'modified');

    const blocked = await runBlocked(world, 'Edit', file);
    expect(blocked.output).toContain('changed on disk since');

    await runOk(world, 'Read', file);
    await runOk(world, 'Edit', file);
  });

  it('checks the file at execution time rather than during preflight', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await runOk(world, 'Read', file);

    const ctx = beforeCtx('Edit', file);
    await world.executor.hooks.onBeforeExecuteTool.run(ctx);
    writeFileSync(file, 'changed while queued');

    const blocked = await runPrepared(ctx);
    expect(blocked?.isError).toBe(true);
    expect(blocked?.output).toContain('changed on disk since');
  });

  it('keeps the revision captured by Read when the file changes before the did-hook', async () => {
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

    const blocked = await runBlocked(world, 'Edit', file);
    expect(blocked.output).toContain('changed on disk since');
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
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, 'hello');

    const blocked = await runBlocked(world, 'Write', file);
    expect(blocked.output).toContain('already exists');
    expect(blocked.output).toContain('has not been read in this session');
  });

  it('allows Write creating a new file and baselines it', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'new.txt');

    await runOk(world, 'Write', file);
    await runOk(world, 'Edit', file);
  });

  it('allows Edit right after a full Read', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, 'hello');

    await runOk(world, 'Read', file);
    await runOk(world, 'Edit', file);
  });

  it('allows consecutive Edits without watcher events', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, 'hello');

    await runOk(world, 'Read', file);
    await runOk(world, 'Edit', file);
    await runOk(world, 'Edit', file);
  });

  it('keeps consecutive Edits clean through the own-write watcher echo and re-baselines', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await runOk(world, 'Read', file);
    expect(world.env.statCalls()).toBe(0);

    foldChange(world, 'a.txt', 'modified');

    await runOk(world, 'Edit', file);
    expect(world.env.statCalls()).toBe(1);

    await runOk(world, 'Edit', file);
    expect(world.env.statCalls()).toBe(2);
  });

  it('resolves a truncated window by stat punch: unchanged passes, changed blocks', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await runOk(world, 'Read', file);

    foldJunk(world.env);

    await runOk(world, 'Edit', file);

    writeFileSync(file, 'hello world');
    foldJunk(world.env);

    const blocked = await runBlocked(world, 'Edit', file);
    expect(blocked.output).toContain('changed on disk since');
  });

  it('blocks ranged-Read followed by Edit because ranged reads never baseline', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, '1\n2\n3\n4\n5\n6\n');

    await runOk(world, 'Read', file, { args: { path: file, line_offset: 5 } });
    const blocked = await runBlocked(world, 'Edit', file);
    expect(blocked.output).toContain('has not been read in this session');
  });

  it('blocks out-of-root writes through the stat-only fallback and allows them after Read', async () => {
    const world = setup();
    const file = join(world.env.outsideDir, 'b.txt');
    writeFileSync(file, 'hello');

    const first = await runBlocked(world, 'Edit', file);
    expect(first.output).toContain('has not been read in this session');

    await runOk(world, 'Read', file);
    await runOk(world, 'Edit', file);

    writeFileSync(file, 'hello world');
    const changed = await runBlocked(world, 'Edit', file);
    expect(changed.output).toContain('changed on disk since');
  });

  it('ensures an additional dir becomes watched when a write target falls under it', async () => {
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

    const blocked = await runBlocked(world, 'Write', file);
    expect(blocked.output).toContain('changed on disk since');
  });

  it('keeps ledgers on two session scopes sharing one workspace independent and flags the peer change', async () => {
    const env = makeEnv();
    const worldA = makeAgent(env, makeSession(env, 'sA', env.workDir));
    const worldB = makeAgent(env, makeSession(env, 'sB', env.workDir));
    const file = join(env.workDir, 'a.txt');
    writeFileSync(file, 'hello');

    await runOk(worldA, 'Read', file);

    const neverRead = await runBlocked(worldB, 'Edit', file);
    expect(neverRead.output).toContain('has not been read in this session');

    writeFileSync(file, 'hello world');
    env.fake.handles
      .findLast((h) => h.root === env.workDir)
      ?.fire('a.txt', 'modified');
    vi.advanceTimersByTime(200);

    const conflict = await runBlocked(worldB, 'Edit', file);
    expect(conflict.output).toContain('changed on disk since');
  });

  it('leaves direct creation of a new file without a result note', async () => {
    const world = setup();
    const did = await runOk(world, 'Write', join(world.env.workDir, 'new.txt'));
    expect(did.result.note).toBeUndefined();
  });

  it('records no baseline and stays blocked when the fenced call fails', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await runOk(world, 'Read', file);

    writeFileSync(file, 'hello world');
    foldChange(world, 'a.txt', 'modified');

    // The stale verdict blocks the Edit; the wrapper's error result must not
    // be baselined by the did-hook, so the file stays stale until re-read.
    const failed = beforeCtx('Edit', file);
    await world.executor.hooks.onBeforeExecuteTool.run(failed);
    const failedResult = await runPrepared(failed);
    expect(failedResult?.isError).toBe(true);
    await runDid(world, failed, { output: 'boom', isError: true });

    const retry = await runBlocked(world, 'Edit', file);
    expect(retry.output).toContain('changed on disk since');
  });

  it('does not leak a target across turns', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, 'hello');

    await runBefore(world, beforeCtx('Edit', file, { id: 'call-abandoned', turnId: 1 }));
    await runBefore(
      world,
      beforeCtx('Edit', join(world.env.workDir, 'other.txt'), { turnId: 2 }),
    );

    // A late did-hook for the abandoned turn-1 call finds no swept target and
    // records nothing: a.txt stays never-read, so a real Edit still blocks.
    const abandonedCtx = beforeCtx('Edit', file, { id: 'call-abandoned', turnId: 1 });
    await runDid(world, abandonedCtx);
    const retry = await runBlocked(world, 'Edit', file);
    expect(retry.output).toContain('has not been read in this session');
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
