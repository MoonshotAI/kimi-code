/**
 * `fileFencing` domain (L4) — verifies the write/read-first gate end to end
 * through the real DI scope tree: a real tmpdir, the real `HostFileSystem`,
 * and the registered `writeFencing` hook participant over a real
 * `OrderedHookSlot`. Covers the hard-block verdicts (stale outside change /
 * never-read existing file), stat-only checks, and ledger isolation between
 * two Session scopes sharing one workspace.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LifecycleScope, type Scope } from '#/_base/di/scope';
import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { IAgentFileFencingService } from '#/agent/fileFencing/fileFencing';
import { AgentFileFencingService } from '#/agent/fileFencing/fileFencingService';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  ToolBeforeExecuteContext,
  ToolDidExecuteContext,
} from '#/agent/toolExecutor/toolHooks';
import type { ToolCall } from '#/kosong/contract/message';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionFileLedger } from '#/session/sessionFileLedger/fileLedger';
import { SessionFileLedger } from '#/session/sessionFileLedger/fileLedgerService';
import {
  ToolAccesses,
  type ExecutableToolResult,
  makeToolFileRevision,
  toolFileRevision,
} from '#/tool/toolContract';

import { AgentToolExecutorService } from '#/agent/toolExecutor/toolExecutorService';

import { stubToolExecutor } from '../loop/stubs';
import { countingHostFs } from '../../session/sessionFs/stubs';

void AgentFileFencingService;
void SessionFileLedger;
void AgentToolExecutorService;

interface Env {
  readonly host: ScopedTestHost;
  readonly workDir: string;
  readonly outsideDir: string;
  readonly statCalls: () => number;
}

function makeEnv(): Env {
  const workDir = mkdtempSync(join(tmpdir(), 'kimi-fencing-work-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'kimi-fencing-out-'));
  cleanupPaths.push(workDir, outsideDir);
  const { fs, statCalls } = countingHostFs();
  const host = createScopedTestHost([stubPair(IHostFileSystem, fs)]);
  hosts.push(host);
  return { host, workDir, outsideDir, statCalls };
}

interface AgentWorld {
  readonly env: Env;
  readonly session: Scope;
  readonly agent: Scope;
  readonly executor: IAgentToolExecutorService;
  readonly ledger: ISessionFileLedger;
}

function makeAgent(env: Env, session: Scope): AgentWorld {
  const executor = stubToolExecutor();
  const agent = env.host.childOf(session, LifecycleScope.Agent, 'main', [
    stubPair(IAgentToolExecutorService, executor),
  ]);
  agent.accessor.get(IAgentFileFencingService);
  return {
    env,
    session,
    agent,
    executor,
    ledger: session.accessor.get(ISessionFileLedger),
  };
}

function setup(): AgentWorld {
  const env = makeEnv();
  return makeAgent(env, env.host.child(LifecycleScope.Session, 's1'));
}

function beforeCtx(
  toolName: string,
  path: string,
  opts: { args?: Record<string, unknown> } = {},
): ToolBeforeExecuteContext {
  const args =
    opts.args ??
    (toolName === 'Edit'
      ? { path, old_string: 'a', new_string: 'b' }
      : toolName === 'Write'
        ? { path, content: 'x' }
        : { path });
  const toolCall: ToolCall = {
    type: 'function',
    id: 'call-1',
    name: toolName,
    arguments: JSON.stringify(args),
  };
  const operation = toolName === 'Read' ? 'read' : toolName === 'Write' ? 'write' : 'readwrite';
  return {
    turnId: 1,
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
  opts: { args?: Record<string, unknown> } = {},
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

const hosts: ScopedTestHost[] = [];
const cleanupPaths: string[] = [];

describe('AgentFileFencingService', () => {
  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
    for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
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

    // An intervening successful Edit re-baselines, so the next Edit starts clean.
    await runOk(world, 'Edit', file);

    writeFileSync(file, 'hello world');

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

  it('blocks Write over an existing file that was never read', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, 'hello');

    const blocked = await runBlocked(world, 'Write', file);
    expect(blocked.output).toContain('already exists');
    expect(blocked.output).toContain('has not been read in this session');
  });

  it('allows Write append on an existing file without a read baseline', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, 'before');

    await runOk(world, 'Write', file, {
      args: { path: file, content: ' after', mode: 'append' },
    });

    expect(readFileSync(file, 'utf8')).toBe('before after');
  });

  it('allows Write creating a new file and baselines it', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'new.txt');

    await runOk(world, 'Write', file);
    expect(await world.ledger.compare(file)).toBe('clean');

    await runOk(world, 'Edit', file);
  });

  it('allows consecutive Edits and keeps them clean while the stat tuple matches the baseline', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await runOk(world, 'Read', file);
    expect(world.env.statCalls()).toBe(0);

    await runOk(world, 'Edit', file);
    expect(world.env.statCalls()).toBe(1);

    await runOk(world, 'Edit', file);
    expect(world.env.statCalls()).toBe(2);

    expect(await world.ledger.compare(file)).toBe('clean');
  });

  it('blocks ranged-Read followed by Edit because ranged reads never baseline', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, '1\n2\n3\n4\n5\n6\n');

    await runOk(world, 'Read', file, { args: { path: file, line_offset: 5 } });
    const blocked = await runBlocked(world, 'Edit', file);
    expect(blocked.output).toContain('has not been read in this session');
  });

  it('keeps Edit blocked when a default Read has no complete-file revision', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, 'partial read');
    const ctx = await runBefore(world, beforeCtx('Read', file));

    await runDid(world, ctx, { output: 'partial' });

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

  it('records no baseline and stays blocked when the fenced call fails', async () => {
    const world = setup();
    const file = join(world.env.workDir, 'a.txt');
    writeFileSync(file, 'hello');
    await runOk(world, 'Read', file);

    writeFileSync(file, 'hello world');

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
});
