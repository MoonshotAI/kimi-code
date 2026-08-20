/**
 * Monitor subsystem tests — MonitorManager watcher behaviour plus the
 * MonitorCreate/MonitorList/MonitorCancel tool surface.
 *
 * The manager tests run against a stub Agent (same approach as the
 * background manager tests) with a REAL BackgroundManager and the real
 * LocalKaos, so command monitors exercise genuine process spawning and
 * file monitors exercise genuine chokidar events against tmp dirs.
 */

import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { createControlledPromise } from '@antfu/utils';
import type { ContentPart } from '@moonshot-ai/kosong';
import { join } from 'pathe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../../src/agent';
import { BackgroundManager } from '../../../src/agent/background';
import type {
  BackgroundTask,
  BackgroundTaskInfo,
  BackgroundTaskInfoBase,
  BackgroundTaskSink,
} from '../../../src/agent/background/task';
import { MonitorManager, type MonitorRecord } from '../../../src/agent/monitor';
import type { MonitorOrigin } from '../../../src/agent/context/types';
import { FlagResolver } from '../../../src/flags';
import { MonitorCreateInputSchema, MonitorCreateTool } from '../../../src/tools/monitor/monitor-create';
import { MonitorCancelTool } from '../../../src/tools/monitor/monitor-cancel';
import { MonitorListTool } from '../../../src/tools/monitor/monitor-list';
import { testKaos } from '../../fixtures/test-kaos';
import { testAgent } from '../harness/agent';

// ── Fixture ──────────────────────────────────────────────────────────

interface SteerCall {
  readonly content: readonly ContentPart[];
  readonly origin: MonitorOrigin;
}

interface Fixture {
  readonly agent: Agent;
  readonly background: BackgroundManager;
  readonly monitor: MonitorManager;
  readonly steerCalls: SteerCall[];
  readonly hookCalls: unknown[];
}

const fixtures: Fixture[] = [];
const tempDirs: string[] = [];

function createFixture(options: { readonly homedir?: string; readonly cwd?: string } = {}): Fixture {
  const steerCalls: SteerCall[] = [];
  const hookCalls: unknown[] = [];
  const agent = {
    homedir: options.homedir,
    kaos: testKaos,
    config: { cwd: options.cwd ?? process.cwd() },
    turn: {
      steer: (content: readonly ContentPart[], origin: MonitorOrigin) => {
        steerCalls.push({ content, origin });
        return 1;
      },
    },
    context: { appendUserMessage: vi.fn() },
    hooks: { fireAndForgetTrigger: vi.fn((...args: unknown[]) => hookCalls.push(args)) },
    telemetry: { track: vi.fn() },
    log: { warn: vi.fn() },
    emitEvent: vi.fn(),
    kimiConfig: undefined,
  } as unknown as Agent;
  const background = new BackgroundManager(agent, undefined);
  (agent as { background?: BackgroundManager }).background = background;
  const fixture: Fixture = { agent, background, monitor: new MonitorManager(agent), steerCalls, hookCalls };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.monitor.stopAll();
    await fixture.background.stopAll('test cleanup');
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-monitor-test-'));
  tempDirs.push(dir);
  return dir;
}

function steerText(call: SteerCall): string {
  return call.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

async function waitForStatus(fixture: Fixture, id: string, status: string): Promise<MonitorRecord> {
  await vi.waitFor(
    () => {
      expect(fixture.monitor.get(id)?.status).toBe(status);
    },
    { timeout: 15_000, interval: 20 },
  );
  return fixture.monitor.get(id)!;
}

// ── Deterministic output task ────────────────────────────────────────

/**
 * A BackgroundTask whose output chunks are scripted and gated, so tests
 * control exact chunk boundaries (the register → subscribe race would
 * otherwise make chunk-splitting assertions flaky). Terminal
 * notifications are suppressed at registration in every test so the
 * monitor's own steer calls are the only ones observed.
 */
class FakeOutputTask implements BackgroundTask {
  readonly kind = 'process' as const;
  readonly idPrefix = 'bash';
  readonly description = 'fake output task';
  private readonly gate = createControlledPromise<void>();
  private readonly endGate = createControlledPromise<void>();

  constructor(
    private readonly chunks: readonly string[],
    private readonly holdOpen = false,
  ) {}

  release(): void {
    this.gate.resolve();
  }

  finish(): void {
    this.endGate.resolve();
  }

  async start(sink: BackgroundTaskSink): Promise<void> {
    await this.gate;
    for (const chunk of this.chunks) {
      if (sink.signal.aborted) return;
      sink.appendOutput(chunk);
    }
    if (this.holdOpen) {
      await this.endGate;
      if (sink.signal.aborted) return;
    }
    await sink.settle({ status: 'completed' });
  }

  toInfo(base: BackgroundTaskInfoBase): BackgroundTaskInfo {
    return { ...base, kind: 'process', command: 'fake', pid: 0, exitCode: 0 };
  }
}

function registerFake(fixture: Fixture, task: FakeOutputTask): string {
  return fixture.background.registerTask(task, { terminalNotificationSuppressed: true });
}

// ── task_output monitors ─────────────────────────────────────────────

describe('task_output monitor', () => {
  it('matches a pattern across chunk boundaries', async () => {
    const fixture = createFixture();
    const task = new FakeOutputTask(['rea', 'dy\n']);
    const taskId = registerFake(fixture, task);

    const record = await fixture.monitor.create({
      type: 'task_output',
      taskId,
      pattern: '^ready$',
      timeoutS: 60,
    });
    task.release();

    const fired = await waitForStatus(fixture, record.id, 'fired');
    expect(fired.fire?.trigger).toBe('match');
    expect(fired.fire?.matchedLine).toBe('ready');
    expect(fixture.steerCalls).toHaveLength(1);
    const [call] = fixture.steerCalls;
    expect(call!.origin).toMatchObject({
      kind: 'monitor',
      monitorId: record.id,
      monitorType: 'task_output',
      trigger: 'match',
      notificationId: `monitor:${record.id}`,
    });
    const text = steerText(call!);
    expect(text).toContain('category="monitor"');
    expect(text).toContain('Matched line: ready');
    // The Notification hook fires alongside the steer.
    expect(fixture.hookCalls).toHaveLength(1);
  });

  it('caps the carried-over partial line at ~4 KiB', async () => {
    const fixture = createFixture();
    // One giant unterminated chunk: 'HEAD' + 5000 filler chars. The cap
    // drops the head, so 'HEAD' can never match; the later 'READY' line
    // still does.
    const task = new FakeOutputTask([`HEAD${'x'.repeat(5000)}`, '\n', 'READY\n']);
    const taskId = registerFake(fixture, task);

    const record = await fixture.monitor.create({
      type: 'task_output',
      taskId,
      pattern: 'HEAD|READY',
      timeoutS: 60,
    });
    task.release();

    const fired = await waitForStatus(fixture, record.id, 'fired');
    expect(fired.fire?.trigger).toBe('match');
    expect(fired.fire?.matchedLine).toBe('READY');
  });

  it('ends silently when the watched task goes terminal without a match', async () => {
    const fixture = createFixture();
    const task = new FakeOutputTask(['no match here\n']);
    const taskId = registerFake(fixture, task);

    const record = await fixture.monitor.create({
      type: 'task_output',
      taskId,
      pattern: 'needle',
      timeoutS: 60,
    });
    task.release();

    const ended = await waitForStatus(fixture, record.id, 'ended');
    expect(ended.fire).toBeUndefined();
    expect(fixture.steerCalls).toHaveLength(0);
  });

  it('fires on creation when the pattern already appeared in the task backlog', async () => {
    const fixture = createFixture();
    const task = new FakeOutputTask(['BUILD_DONE\n'], true);
    const taskId = registerFake(fixture, task);
    task.release();
    await vi.waitFor(async () => {
      expect(await fixture.background.readOutput(taskId)).toContain('BUILD_DONE');
    });

    const record = await fixture.monitor.create({
      type: 'task_output',
      taskId,
      pattern: 'BUILD_DONE',
      timeoutS: 60,
    });

    const fired = await waitForStatus(fixture, record.id, 'fired');
    expect(fired.fire?.trigger).toBe('match');
    expect(fired.fire?.matchedLine).toBe('BUILD_DONE');
    expect(fixture.steerCalls).toHaveLength(1);
    task.finish();
  });

  it('rejects watching an unknown or terminal task', async () => {
    const fixture = createFixture();
    await expect(
      fixture.monitor.create({
        type: 'task_output',
        taskId: 'bash-missing',
        pattern: 'x',
        timeoutS: 60,
      }),
    ).rejects.toThrow('No background task with id bash-missing');

    const task = new FakeOutputTask(['done\n']);
    const taskId = registerFake(fixture, task);
    task.release();
    await fixture.background.wait(taskId, 10_000);
    await expect(
      fixture.monitor.create({
        type: 'task_output',
        taskId,
        pattern: 'x',
        timeoutS: 60,
      }),
    ).rejects.toThrow(/already completed/);
  });
});

// ── command monitors ─────────────────────────────────────────────────

describe('command monitor', () => {
  it('fires a timeout notification and kills the command', async () => {
    const fixture = createFixture();
    const record = await fixture.monitor.create({
      type: 'command',
      command: 'sleep 60',
      timeoutS: 1,
    });

    const fired = await waitForStatus(fixture, record.id, 'fired');
    expect(fired.fire?.trigger).toBe('timeout');
    expect(fixture.steerCalls).toHaveLength(1);
    expect(fixture.steerCalls[0]!.origin.trigger).toBe('timeout');
    expect(steerText(fixture.steerCalls[0]!)).toContain('timed out');

    // The timeout tears the command process down through the shared
    // background stop path (SIGTERM → killed).
    const info = await fixture.background.wait(record.commandTaskId!, 10_000);
    expect(info?.status).toBe('killed');
    // The suppressed terminal notification must not double-report: the
    // timeout steer is still the only one.
    expect(fixture.steerCalls).toHaveLength(1);
  });

  it('fires an exit notification with the exit code when the command exits first', async () => {
    const fixture = createFixture();
    const record = await fixture.monitor.create({
      type: 'command',
      command: "sh -c 'exit 3'",
      timeoutS: 60,
    });

    const fired = await waitForStatus(fixture, record.id, 'fired');
    expect(fired.fire?.trigger).toBe('exit');
    expect(fired.fire?.exitCode).toBe(3);
    expect(fixture.steerCalls).toHaveLength(1);
    expect(steerText(fixture.steerCalls[0]!)).toContain('exited with code 3');
  });

  it('fires on a pattern match and kills the long-running command', async () => {
    const fixture = createFixture();
    const record = await fixture.monitor.create({
      type: 'command',
      command: "sh -c 'echo ready; sleep 60'",
      pattern: '^ready$',
      timeoutS: 60,
    });

    const fired = await waitForStatus(fixture, record.id, 'fired');
    expect(fired.fire?.trigger).toBe('match');
    expect(fired.fire?.matchedLine).toBe('ready');

    const info = await fixture.background.wait(record.commandTaskId!, 10_000);
    expect(info?.status).toBe('killed');
    // Only the monitor notification was steered — the command's terminal
    // notification stayed suppressed.
    expect(fixture.steerCalls).toHaveLength(1);
  });
});

// ── file monitors ────────────────────────────────────────────────────

describe('file monitor', () => {
  it('fires on file creation inside a watched directory', async () => {
    const dir = await makeTmpDir();
    const fixture = createFixture({ cwd: dir });
    const record = await fixture.monitor.create({
      type: 'file',
      path: dir,
      events: ['created'],
      timeoutS: 30,
    });

    await writeFile(join(dir, 'new-file.txt'), 'hello');

    const fired = await waitForStatus(fixture, record.id, 'fired');
    expect(fired.fire?.trigger).toBe('match');
    expect(fired.fire?.fileEvent).toBe('created');
    expect(fired.fire?.filePath).toBe(join(await realpath(dir), 'new-file.txt'));
  });

  it('fires for a watch path that passes through a symlinked directory', async () => {
    const realDir = await makeTmpDir();
    const link = `${realDir}-link`;
    tempDirs.push(link);
    await symlink(realDir, link);
    const fixture = createFixture({ cwd: realDir });
    const record = await fixture.monitor.create({
      type: 'file',
      path: join(link, 'done.txt'),
      events: ['created'],
      timeoutS: 30,
    });

    await writeFile(join(realDir, 'done.txt'), 'x');

    const fired = await waitForStatus(fixture, record.id, 'fired');
    expect(fired.fire?.trigger).toBe('match');
    expect(fired.fire?.fileEvent).toBe('created');
  });

  it('fires only when the changed path matches the optional pattern', async () => {
    const dir = await makeTmpDir();
    const fixture = createFixture({ cwd: dir });
    const record = await fixture.monitor.create({
      type: 'file',
      path: dir,
      events: ['created'],
      pattern: '\\.log$',
      timeoutS: 30,
    });

    await writeFile(join(dir, 'ignored.txt'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fixture.monitor.get(record.id)?.status).toBe('active');

    await writeFile(join(dir, 'app.log'), 'x');
    const fired = await waitForStatus(fixture, record.id, 'fired');
    expect(fired.fire?.trigger).toBe('match');
    expect(fired.fire?.fileEvent).toBe('created');
    expect(fired.fire?.filePath).toBe(join(await realpath(dir), 'app.log'));
  });

  it('fires on modification of a watched file, not on the initial state', async () => {
    const dir = await makeTmpDir();
    const target = join(dir, 'watched.log');
    await writeFile(target, 'initial');
    const fixture = createFixture({ cwd: dir });
    const record = await fixture.monitor.create({
      type: 'file',
      path: target,
      events: ['modified'],
      timeoutS: 30,
    });

    // ignoreInitial: the pre-existing content must not fire the monitor.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fixture.monitor.get(record.id)?.status).toBe('active');

    await appendFile(target, 'more');

    const fired = await waitForStatus(fixture, record.id, 'fired');
    expect(fired.fire?.fileEvent).toBe('modified');
    expect(fired.fire?.filePath).toBe(await realpath(target));
  });

  it('matches globs via the static-prefix directory and picomatch filter', async () => {
    const dir = await makeTmpDir();
    await mkdir(join(dir, 'logs'));
    const fixture = createFixture({ cwd: dir });
    const record = await fixture.monitor.create({
      type: 'file',
      path: join(dir, 'logs', '*.log'),
      events: ['created'],
      timeoutS: 30,
    });

    // A non-matching extension must not fire the monitor.
    await writeFile(join(dir, 'logs', 'ignored.txt'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fixture.monitor.get(record.id)?.status).toBe('active');

    await writeFile(join(dir, 'logs', 'app.log'), 'x');

    const fired = await waitForStatus(fixture, record.id, 'fired');
    expect(fired.fire?.fileEvent).toBe('created');
    expect(fired.fire?.filePath).toBe(join(await realpath(dir), 'logs', 'app.log'));
  });
});

// ── cancel ───────────────────────────────────────────────────────────

describe('monitor cancel', () => {
  it('cancels an active monitor and suppresses further notifications', async () => {
    const dir = await makeTmpDir();
    const fixture = createFixture({ cwd: dir });
    const record = await fixture.monitor.create({
      type: 'file',
      path: dir,
      timeoutS: 30,
    });

    const cancelled = fixture.monitor.cancel(record.id);
    expect(cancelled?.status).toBe('cancelled');

    await writeFile(join(dir, 'late.txt'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fixture.steerCalls).toHaveLength(0);
  });

  it('returns undefined for unknown ids and reports terminal monitors', async () => {
    const fixture = createFixture();
    expect(fixture.monitor.cancel('mon-00000000')).toBeUndefined();
  });

  it('MonitorCancel tool validates id shape and reports status', async () => {
    const dir = await makeTmpDir();
    const fixture = createFixture({ cwd: dir });
    const tool = new MonitorCancelTool(fixture.monitor);

    const badId = tool.resolveExecution({ id: 'nope' });
    expect(badId.isError).toBe(true);

    const record = await fixture.monitor.create({ type: 'file', path: dir, timeoutS: 30 });
    const missing = tool.resolveExecution({ id: 'mon-00000000' });
    if (missing.isError === true) throw new Error('expected runnable execution');
    const missingResult = await missing.execute({} as never);
    expect(missingResult.isError).toBe(true);
    expect(missingResult.output).toContain('No monitor with id mon-00000000');

    const ok = tool.resolveExecution({ id: record.id });
    if (ok.isError === true) throw new Error('expected runnable execution');
    const okResult = await ok.execute({} as never);
    expect(okResult.isError).toBe(false);
    expect(okResult.output).toBe(`Cancelled monitor ${record.id}.`);
    expect(fixture.monitor.get(record.id)?.status).toBe('cancelled');
  });
});

// ── persistence / resume ─────────────────────────────────────────────

describe('monitor persistence', () => {
  it('marks persisted active monitors lost on resume without re-attaching', async () => {
    const dir = await makeTmpDir();
    // Watch a subdirectory — the session homedir itself holds the
    // persisted monitor records, and watching it would make every
    // persistence write a file event.
    const watchDir = join(dir, 'watched');
    await mkdir(watchDir);
    const first = createFixture({ homedir: dir, cwd: dir });
    const record = await first.monitor.create({ type: 'file', path: watchDir, timeoutS: 3600 });
    await first.monitor.flushPersist();
    await first.monitor.stopAll();

    const resumed = createFixture({ homedir: dir, cwd: dir });
    await resumed.monitor.loadFromDisk();

    const restored = resumed.monitor.get(record.id);
    expect(restored?.status).toBe('lost');
    // A later event must not fire the lost monitor.
    await writeFile(join(watchDir, 'after-resume.txt'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(resumed.steerCalls).toHaveLength(0);
  });

  it('re-appends a fired-but-undelivered notification on resume', async () => {
    const dir = await makeTmpDir();
    const first = createFixture({ homedir: dir, cwd: dir });
    const task = new FakeOutputTask(['ready\n']);
    const taskId = registerFake(first, task);
    const record = await first.monitor.create({
      type: 'task_output',
      taskId,
      pattern: '^ready$',
      timeoutS: 3600,
    });
    task.release();
    await waitForStatus(first, record.id, 'fired');
    await first.monitor.flushPersist();

    // Simulate a crash between fire and delivery: the resumed manager
    // never saw the notification land in history, so it must re-append
    // it straight to the context (no steer).
    const resumed = createFixture({ homedir: dir, cwd: dir });
    await resumed.monitor.loadFromDisk();

    expect(resumed.monitor.get(record.id)?.status).toBe('fired');
    expect(resumed.steerCalls).toHaveLength(0);
    const appendUserMessage = resumed.agent.context.appendUserMessage as ReturnType<typeof vi.fn>;
    expect(appendUserMessage).toHaveBeenCalledTimes(1);
    const [content, origin] = appendUserMessage.mock.calls[0]! as [readonly ContentPart[], MonitorOrigin];
    expect(origin).toMatchObject({
      kind: 'monitor',
      monitorId: record.id,
      trigger: 'match',
      notificationId: `monitor:${record.id}`,
    });
    expect(content.map((part) => (part.type === 'text' ? part.text : '')).join('')).toContain(
      'Matched line: ready',
    );
  });

  it('does not re-append a notification that was already delivered', async () => {
    const dir = await makeTmpDir();
    const first = createFixture({ homedir: dir, cwd: dir });
    const task = new FakeOutputTask(['ready\n']);
    const taskId = registerFake(first, task);
    const record = await first.monitor.create({
      type: 'task_output',
      taskId,
      pattern: '^ready$',
      timeoutS: 3600,
    });
    task.release();
    await waitForStatus(first, record.id, 'fired');
    await first.monitor.flushPersist();

    const resumed = createFixture({ homedir: dir, cwd: dir });
    // The pre-crash history already contained the notification — replay
    // marks it delivered through the same path ContextMemory uses.
    resumed.monitor.markDeliveredNotification({
      kind: 'monitor',
      monitorId: record.id,
      monitorType: 'task_output',
      trigger: 'match',
      notificationId: `monitor:${record.id}`,
    });
    await resumed.monitor.loadFromDisk();

    const appendUserMessage = resumed.agent.context.appendUserMessage as ReturnType<typeof vi.fn>;
    expect(appendUserMessage).not.toHaveBeenCalled();
  });
});

// ── tool schema + flag gating ────────────────────────────────────────

describe('MonitorCreate tool', () => {
  it('rejects timeout above the 24h ceiling at the schema level', () => {
    expect(
      MonitorCreateInputSchema.safeParse({ type: 'command', command: 'x', timeout: 86_401 })
        .success,
    ).toBe(false);
    expect(
      MonitorCreateInputSchema.safeParse({ type: 'command', command: 'x', timeout: 86_400 })
        .success,
    ).toBe(true);
    // Default applies when omitted.
    const parsed = MonitorCreateInputSchema.parse({ type: 'command', command: 'x' });
    expect(parsed.timeout).toBe(3600);
  });

  it('rejects an invalid regex pattern with an actionable error', () => {
    const fixture = createFixture();
    const tool = new MonitorCreateTool(fixture.monitor);
    const result = tool.resolveExecution({
      type: 'task_output',
      task_id: 'bash-xxxxxxxx',
      pattern: '(',
      timeout: 60,
    });
    expect(result.isError).toBe(true);
    if (result.isError === true) {
      expect(result.output).toContain('Invalid regex pattern');
    }

    const badFilePattern = tool.resolveExecution({
      type: 'file',
      path: 'x',
      pattern: '(',
      timeout: 60,
    });
    expect(badFilePattern.isError).toBe(true);
  });

  it('accepts an optional pattern on the file branch', () => {
    expect(
      MonitorCreateInputSchema.safeParse({ type: 'file', path: 'logs/', pattern: '\\.log$' })
        .success,
    ).toBe(true);
  });

  it('creates a monitor through the tool and lists it', async () => {
    const dir = await makeTmpDir();
    const fixture = createFixture({ cwd: dir });
    const create = new MonitorCreateTool(fixture.monitor);
    const execution = create.resolveExecution({
      type: 'file',
      path: dir,
      timeout: 30,
    });
    if (execution.isError === true) throw new Error('unexpected prepare error');
    const result = await execution.execute({} as never);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('type: file');
    expect(result.output).toContain('status: active');

    const list = new MonitorListTool(fixture.monitor);
    const listExecution = list.resolveExecution({});
    if (listExecution.isError === true) throw new Error('unexpected prepare error');
    const listResult = await listExecution.execute({} as never);
    expect(listResult.output).toContain('monitors: 1');
    expect(listResult.output).toContain('type: file');
  });
});

describe('monitor experimental flag', () => {
  const MONITOR_TOOLS = ['MonitorCreate', 'MonitorList', 'MonitorCancel'];

  it('does not register monitor tools when the flag is off', () => {
    const ctx = testAgent({ experimentalFlags: new FlagResolver({}) });
    ctx.configure({ tools: [...MONITOR_TOOLS] });
    const names = ctx.agent.tools.loopTools.map((tool) => tool.name);
    for (const name of MONITOR_TOOLS) {
      expect(names).not.toContain(name);
    }
  });

  it('registers monitor tools when the flag is on', () => {
    const ctx = testAgent({
      experimentalFlags: new FlagResolver({ KIMI_CODE_EXPERIMENTAL_MONITOR: '1' }),
    });
    ctx.configure({ tools: [...MONITOR_TOOLS] });
    const names = ctx.agent.tools.loopTools.map((tool) => tool.name);
    for (const name of MONITOR_TOOLS) {
      expect(names).toContain(name);
    }
  });
});

// ── session-level E2E ────────────────────────────────────────────────

describe('monitor session E2E', () => {
  it('MonitorCreate on a real agent fires a monitor-origin steer on pattern match', async () => {
    const ctx = testAgent({
      experimentalFlags: new FlagResolver({ KIMI_CODE_EXPERIMENTAL_MONITOR: '1' }),
    });
    ctx.configure({ tools: ['MonitorCreate'] });
    try {
      // Wrap rather than replace steer so the real steer path (record
      // write / turn launch against the scripted generate) still runs.
      const steerCalls: SteerCall[] = [];
      const originalSteer = ctx.agent.turn.steer.bind(ctx.agent.turn);
      (ctx.agent.turn as unknown as { steer: typeof ctx.agent.turn.steer }).steer =
        (content, origin) => {
          steerCalls.push({ content, origin: origin as MonitorOrigin });
          return originalSteer(content, origin);
        };
      // The fired notification launches an idle turn; give the scripted
      // generate one response so that turn completes cleanly.
      ctx.mockNextResponse({ type: 'text', text: 'noted' });

      const tool = new MonitorCreateTool(ctx.agent.monitor!);
      const execution = tool.resolveExecution({
        type: 'command',
        command: "sh -c 'echo ready; sleep 60'",
        pattern: 'ready',
        timeout: 60,
      });
      if (execution.isError === true) throw new Error('unexpected prepare error');
      const createResult = await execution.execute({
        turnId: 'monitor-e2e',
        toolCallId: 'monitor-e2e-call',
        signal: new AbortController().signal,
      });
      expect(createResult.isError ?? false).toBe(false);
      const idMatch = /id: (mon-[0-9a-z]+)/.exec(
        typeof createResult.output === 'string' ? createResult.output : JSON.stringify(createResult.output),
      );
      expect(idMatch).not.toBeNull();
      const id = idMatch![1]!;

      await vi.waitFor(
        () => {
          expect(steerCalls.length).toBe(1);
        },
        { timeout: 15_000, interval: 20 },
      );
      const fire = steerCalls[0]!;
      expect(fire.origin).toMatchObject({
        kind: 'monitor',
        monitorId: id,
        monitorType: 'command',
        trigger: 'match',
      });
      const fireText = fire.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      expect(fireText).toContain('<notification');
      expect(fireText).toContain('ready');

      await vi.waitFor(
        () => {
          expect(ctx.agent.monitor!.get(id)?.status).toBe('fired');
        },
        { timeout: 15_000, interval: 20 },
      );
      // One-shot semantics: the matched command process is terminated.
      await vi.waitFor(
        () => {
          expect(
            ctx.agent.background.list().every((task) => task.status !== 'running'),
          ).toBe(true);
        },
        { timeout: 15_000, interval: 20 },
      );
    } finally {
      await ctx.agent.monitor?.stopAll();
      await ctx.agent.background.stopAll('test cleanup');
    }
  });
});
