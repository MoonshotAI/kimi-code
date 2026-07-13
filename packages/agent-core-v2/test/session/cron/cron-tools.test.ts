import { describe, expect, it } from 'vitest';

import type { CronJobOrigin } from '@moonshot-ai/protocol';

import type {
  ExecutableTool,
  ExecutableToolResult,
  RunnableToolExecution,
  ToolExecution,
} from '#/tool/toolContract';
import type { CronTask, CronTaskInit } from '#/app/cron/cronTask';
import type { ISessionCronService } from '#/session/cron/sessionCronService';
import {
  computeNextCronRun,
  parseCronExpression,
} from '#/app/cron/cron-expr';
import { renderCronFireXml } from '#/app/cron/format';
import {
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
} from '#/app/cron/jitter';
import {
  CronCreateTool,
  MAX_CRON_JOBS_PER_SESSION,
  type CronCreateInput,
} from '#/session/cron/tools/cron-create';
import { CronDeleteTool, type CronDeleteInput } from '#/session/cron/tools/cron-delete';
import { CronListTool, type CronListInput } from '#/session/cron/tools/cron-list';

const WALL_ANCHOR = 1_700_000_000_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TRUNCATED = '\u2026(truncated)';

interface FakeStore {
  add(init: CronTaskInit, nowMs: number): CronTask;
  adopt(task: CronTask): void;
  list(): readonly CronTask[];
}

interface ToolHarness {
  readonly store: FakeStore;
  readonly cron: ISessionCronService;
  readonly scheduled: CronTask[];
  readonly deleted: string[];
  setNow(value: number): void;
  setDisabled(value: boolean): void;
  advance(ms: number): void;
  now(): number;
}

function createToolHarness(options: {
  readonly now?: number;
  readonly noJitter?: boolean;
  readonly disabled?: boolean;
} = {}): ToolHarness {
  let now = options.now ?? WALL_ANCHOR;
  const noJitter = options.noJitter ?? true;
  let disabled = options.disabled ?? false;
  const tasks = new Map<string, CronTask>();
  const scheduled: CronTask[] = [];
  const deleted: string[] = [];
  let idCounter = 0;

  const store: FakeStore = {
    add(init, nowMs) {
      idCounter += 1;
      const id = idCounter.toString(16).padStart(8, '0');
      const task: CronTask = { ...init, id, createdAt: nowMs };
      tasks.set(id, task);
      return task;
    },
    adopt(task) {
      tasks.set(task.id, task);
    },
    list() {
      return Array.from(tasks.values());
    },
  };

  const cron: ISessionCronService = {
    _serviceBrand: undefined,
    isEnabled: true,
    isDisabled: () => disabled,
    now: () => now,
    list: () => store.list(),
    getTask: (id) => tasks.get(id),
    addTask: (init) => store.add(init, now),
    removeTasks: (ids) => ids.filter((id) => tasks.delete(id)),
    isStale(task) {
      const age = now - task.createdAt;
      return task.recurring !== false && Number.isFinite(age) && age >= 7 * MS_PER_DAY;
    },
    getNextFireForTask(taskId) {
      const task = tasks.get(taskId);
      if (task === undefined) return null;
      try {
        const parsed = parseCronExpression(task.cron);
        const ideal = computeNextCronRun(parsed, task.createdAt);
        if (ideal === null) return null;
        return task.recurring === false
          ? oneShotJitteredNextCronRunMs(task, ideal, undefined, noJitter)
          : jitteredNextCronRunMs(task, parsed, ideal, undefined, noJitter);
      } catch {
        return null;
      }
    },
    computeDisplayNextFire(task, parsed, idealMs) {
      return task.recurring === false
        ? oneShotJitteredNextCronRunMs(task, idealMs, undefined, noJitter)
        : jitteredNextCronRunMs(task, parsed, idealMs, undefined, noJitter);
    },
    getNextFireTime: () => null,
    emitScheduled: (task) => {
      scheduled.push(task);
    },
    emitDeleted: (id) => {
      deleted.push(id);
    },
    loadFromStore: async () => {},
    start: () => Promise.resolve(),
    stop: async () => {},
    tick: () => Promise.resolve(),
    flushPersist: async () => {},
    handleMissed: () => undefined,
  };

  return {
    store,
    cron,
    scheduled,
    deleted,
    setNow(value: number) {
      now = value;
    },
    setDisabled(value: boolean) {
      disabled = value;
    },
    advance(ms: number) {
      now += ms;
    },
    now() {
      return now;
    },
  };
}

async function runTool<Input>(
  tool: ExecutableTool<Input>,
  input: Input,
): Promise<ExecutableToolResult> {
  const execution = await tool.resolveExecution(input);
  if (!isRunnableExecution(execution)) return execution;
  return execution.execute({
    turnId: 0,
    toolCallId: 'test-call',
    signal: new AbortController().signal,
  });
}

function isRunnableExecution(execution: ToolExecution): execution is RunnableToolExecution {
  return 'execute' in execution;
}

function assertSuccess(result: ExecutableToolResult): string {
  expect(result.isError ?? false).toBe(false);
  expect(typeof result.output).toBe('string');
  return result.output as string;
}

function assertError(result: ExecutableToolResult): string {
  expect(result.isError).toBe(true);
  expect(typeof result.output).toBe('string');
  return result.output as string;
}

function scrubCronOutput(output: string): string {
  return output
    .replace(/[0-9a-f]{8}/g, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}/g, '<iso>');
}

function localIsoWithOffset(ms: number): string {
  const date = new Date(ms);
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(
    3,
    '0',
  )}${offset}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

describe('CronCreateTool', () => {
  it('schedules a recurring task and emits scheduled telemetry through the manager', async () => {
    const harness = createToolHarness();
    const tool = new CronCreateTool(harness.cron);

    const out = assertSuccess(
      await runTool<CronCreateInput>(tool, {
        cron: '*/5 * * * *',
        prompt: 'ping',
        recurring: true,
      }),
    );

    const task = harness.store.list()[0]!;
    expect(task).toMatchObject({
      cron: '*/5 * * * *',
      prompt: 'ping',
      recurring: true,
      createdAt: WALL_ANCHOR,
    });
    expect(task.id).toMatch(/^[0-9a-f]{8}$/);
    expect(harness.scheduled).toEqual([task]);
    expect(scrubCronOutput(out)).toMatchInlineSnapshot(`
      "id: <id>
      cron: */5 * * * *
      humanSchedule: every 5 minutes
      recurring: true
      nextFireAt: <iso>"
    `);
  });

  it('stores explicit one-shot tasks with recurring=false', async () => {
    const harness = createToolHarness();
    const tool = new CronCreateTool(harness.cron);

    const out = assertSuccess(
      await runTool<CronCreateInput>(tool, {
        cron: '0 12 * * *',
        prompt: 'noon',
        recurring: false,
      }),
    );

    expect(harness.store.list()[0]).toMatchObject({
      cron: '0 12 * * *',
      prompt: 'noon',
      recurring: false,
    });
    expect(out).toContain('recurring: false');
  });

  it('returns an error when scheduling is disabled', async () => {
    const harness = createToolHarness();
    harness.setDisabled(true);
    const tool = new CronCreateTool(harness.cron);

    const output = assertError(
      await runTool<CronCreateInput>(tool, {
        cron: '*/5 * * * *',
        prompt: 'ping',
        recurring: true,
      }),
    );

    expect(output).toMatch(/disabled/);
    expect(harness.store.list()).toEqual([]);
  });

  it('rejects an unparseable cron expression', async () => {
    const harness = createToolHarness();
    const tool = new CronCreateTool(harness.cron);

    const output = assertError(
      await runTool<CronCreateInput>(tool, {
        cron: 'not a cron',
        prompt: 'ping',
        recurring: true,
      }),
    );

    expect(output).toContain('Invalid cron expression');
    expect(output).toContain('exactly 5 fields');
  });

  it('rejects a legal expression that has no fire inside the supported window', async () => {
    const harness = createToolHarness();
    const tool = new CronCreateTool(harness.cron);

    const output = assertError(
      await runTool<CronCreateInput>(tool, {
        cron: '0 0 31 2 *',
        prompt: 'never',
        recurring: true,
      }),
    );

    expect(output).toContain('has no fire within 5 years');
  });

  it('refuses to schedule past the session cap', async () => {
    const harness = createToolHarness();
    const tool = new CronCreateTool(harness.cron);

    for (let i = 0; i < MAX_CRON_JOBS_PER_SESSION; i++) {
      harness.store.add({ cron: '*/5 * * * *', prompt: `seed-${i}`, recurring: true }, harness.now());
    }

    const output = assertError(
      await runTool<CronCreateInput>(tool, {
        cron: '*/5 * * * *',
        prompt: 'overflow',
        recurring: true,
      }),
    );

    expect(output).toBe(`Cron job cap reached (max ${MAX_CRON_JOBS_PER_SESSION} per session).`);
  });

  it('rechecks the session cap inside execute', async () => {
    const harness = createToolHarness();
    const tool = new CronCreateTool(harness.cron);

    for (let i = 0; i < MAX_CRON_JOBS_PER_SESSION - 1; i++) {
      harness.store.add({ cron: '*/5 * * * *', prompt: `seed-${i}`, recurring: true }, harness.now());
    }

    const first = tool.resolveExecution({
      cron: '*/5 * * * *',
      prompt: 'first',
      recurring: true,
    });
    const second = tool.resolveExecution({
      cron: '*/5 * * * *',
      prompt: 'second',
      recurring: true,
    });
    if (!isRunnableExecution(first) || !isRunnableExecution(second)) {
      throw new Error('expected runnable executions');
    }

    assertSuccess(await first.execute({
      turnId: 0,
      toolCallId: 'first',
      signal: new AbortController().signal,
    }));
    const output = assertError(await second.execute({
      turnId: 0,
      toolCallId: 'second',
      signal: new AbortController().signal,
    }));

    expect(output).toBe(`Cron job cap reached (max ${MAX_CRON_JOBS_PER_SESSION} per session).`);
    expect(harness.store.list()).toHaveLength(MAX_CRON_JOBS_PER_SESSION);
  });

  it('rejects prompts over the UTF-8 byte budget', async () => {
    const harness = createToolHarness();
    const tool = new CronCreateTool(harness.cron);
    const prompt = '\u4f60'.repeat(3000);

    const output = assertError(
      await runTool<CronCreateInput>(tool, {
        cron: '*/5 * * * *',
        prompt,
        recurring: true,
      }),
    );

    expect(output).toMatch(/Prompt exceeds 8192 bytes/);
  });

  it('normalizes cron field whitespace before storing and rendering', async () => {
    const harness = createToolHarness();
    const tool = new CronCreateTool(harness.cron);

    const out = assertSuccess(
      await runTool<CronCreateInput>(tool, {
        cron: '  */5\n*\t*\t*\t*  ',
        prompt: 'ping',
        recurring: true,
      }),
    );

    expect(harness.store.list()[0]!.cron).toBe('*/5 * * * *');
    expect(out).toContain('cron: */5 * * * *');
    expect(out).not.toMatch(/cron: \*\/5\n\*/);
  });

  it('uses the execution-time clock for createdAt', async () => {
    const harness = createToolHarness();
    const tool = new CronCreateTool(harness.cron);
    const execution = tool.resolveExecution({
      cron: '*/5 * * * *',
      prompt: 'delayed approval',
      recurring: true,
    });
    if (!isRunnableExecution(execution)) throw new Error('expected runnable execution');

    harness.advance(6 * 60_000);
    assertSuccess(await execution.execute({
      turnId: 0,
      toolCallId: 'test-call',
      signal: new AbortController().signal,
    }));

    expect(harness.store.list()[0]!.createdAt).toBe(harness.now());
  });

  it('includes the normalized payload in the approval rule', async () => {
    const harness = createToolHarness();
    const tool = new CronCreateTool(harness.cron);

    const a = tool.resolveExecution({
      cron: '*/5\n* * * *',
      prompt: 'same',
      recurring: true,
    });
    const b = tool.resolveExecution({
      cron: '0 9 * * *',
      prompt: 'same',
      recurring: true,
    });
    const c = tool.resolveExecution({
      cron: '*/5 * * * *',
      prompt: 'different',
      recurring: true,
    });

    if (!isRunnableExecution(a) || !isRunnableExecution(b) || !isRunnableExecution(c)) {
      throw new Error('expected runnable executions');
    }
    expect(a.approvalRule).toContain('\\*/5 \\* \\* \\* \\*');
    expect(a.approvalRule).toContain('same');
    expect(a.approvalRule).not.toBe(b.approvalRule);
    expect(a.approvalRule).not.toBe(c.approvalRule);
  });
});

describe('CronDeleteTool', () => {
  it('deletes an existing task and emits deletion through the manager', async () => {
    const harness = createToolHarness();
    const task = harness.store.add({ cron: '*/5 * * * *', prompt: 'ping', recurring: true }, harness.now());
    const tool = new CronDeleteTool(harness.cron);

    const output = assertSuccess(await runTool<CronDeleteInput>(tool, { id: task.id }));

    expect(output).toBe(`Deleted cron job ${task.id}.`);
    expect(harness.store.list()).toEqual([]);
    expect(harness.deleted).toEqual([task.id]);
  });

  it('reports an error for a well-formed but absent id', async () => {
    const harness = createToolHarness();
    const tool = new CronDeleteTool(harness.cron);

    const output = assertError(await runTool<CronDeleteInput>(tool, { id: 'deadbeef' }));

    expect(output).toBe('No cron job with id deadbeef.');
    expect(harness.deleted).toEqual([]);
  });

  it.each(['GGGGGGGG', 'deadbee', 'zzzzzzzz', ''])(
    'rejects invalid id %j before mutating the store',
    async (id) => {
      const harness = createToolHarness();
      harness.store.add({ cron: '*/5 * * * *', prompt: 'ping', recurring: true }, harness.now());
      const tool = new CronDeleteTool(harness.cron);

      const output = assertError(await runTool<CronDeleteInput>(tool, { id }));

      expect(output).toContain('must be a ULID');
      expect(harness.store.list()).toHaveLength(1);
      expect(harness.deleted).toEqual([]);
    },
  );
});

describe('CronListTool', () => {
  it('renders the empty case with a zero header and no separator', async () => {
    const harness = createToolHarness();
    const tool = new CronListTool(harness.cron);

    expect(assertSuccess(await runTool<CronListInput>(tool, {}))).toMatchInlineSnapshot(`
      "cron_jobs: 0
      No cron jobs scheduled."
    `);
  });

  it('renders a single recurring task with all expected columns', async () => {
    const harness = createToolHarness();
    const tool = new CronListTool(harness.cron);
    harness.store.add({ cron: '*/5 * * * *', prompt: 'hi', recurring: true }, harness.now());

    const output = assertSuccess(await runTool<CronListInput>(tool, {}));

    expect(scrubCronOutput(output)).toMatchInlineSnapshot(`
      "cron_jobs: 1
      id: <id>
      cron: */5 * * * *
      humanSchedule: every 5 minutes
      prompt: "hi"
      nextFireAt: <iso>
      recurring: true
      ageDays: 0.00
      stale: false"
    `);
  });

  it('renders nextFireAt in local time with an explicit offset', async () => {
    const now = new Date(2026, 4, 29, 8, 35, 0, 0).getTime();
    const harness = createToolHarness({ now });
    const tool = new CronListTool(harness.cron);
    harness.store.add({ cron: '0 9 * * *', prompt: 'morning', recurring: true }, now);

    const output = assertSuccess(await runTool<CronListInput>(tool, {}));
    const expected = new Date(now);
    expected.setSeconds(0, 0);
    expected.setMinutes(0);
    expected.setHours(9);

    expect(output).toContain(`nextFireAt: ${localIsoWithOffset(expected.getTime())}`);
    expect(output).not.toContain('Z');
  });

  it('separates multiple records in insertion order', async () => {
    const harness = createToolHarness();
    const tool = new CronListTool(harness.cron);
    harness.store.add({ cron: '*/5 * * * *', prompt: 'first', recurring: true }, harness.now());
    harness.store.add({ cron: '0 12 * * *', prompt: 'second', recurring: false }, harness.now());

    const output = assertSuccess(await runTool<CronListInput>(tool, {}));

    expect(scrubCronOutput(output)).toMatchInlineSnapshot(`
      "cron_jobs: 2
      id: <id>
      cron: */5 * * * *
      humanSchedule: every 5 minutes
      prompt: "first"
      nextFireAt: <iso>
      recurring: true
      ageDays: 0.00
      stale: false
      ---
      id: <id>
      cron: 0 12 * * *
      humanSchedule: at 12:00 every day
      prompt: "second"
      nextFireAt: <iso>
      recurring: false
      ageDays: 0.00
      stale: false"
    `);
  });

  it('flags recurring tasks older than seven days as stale', async () => {
    const harness = createToolHarness();
    const tool = new CronListTool(harness.cron);
    harness.store.add({ cron: '*/5 * * * *', prompt: 'old', recurring: true }, harness.now() - 8 * MS_PER_DAY);

    const output = assertSuccess(await runTool<CronListInput>(tool, {}));

    expect(scrubCronOutput(output)).toMatchInlineSnapshot(`
      "cron_jobs: 1
      id: <id>
      cron: */5 * * * *
      humanSchedule: every 5 minutes
      prompt: "old"
      nextFireAt: <iso>
      recurring: true
      ageDays: 8.00
      stale: true"
    `);
  });

  it('reports explicit one-shot tasks as recurring=false', async () => {
    const harness = createToolHarness();
    const tool = new CronListTool(harness.cron);
    harness.store.add({ cron: '0 12 * * *', prompt: 'noon', recurring: false }, harness.now());

    const output = assertSuccess(await runTool<CronListInput>(tool, {}));

    expect(output).toContain('recurring: false');
    const match = /^nextFireAt: (.+)$/m.exec(output);
    expect(match).not.toBeNull();
    const renderedMs = Date.parse(match![1]!);
    const expected = new Date(harness.now());
    expected.setSeconds(0, 0);
    expected.setMinutes(0);
    expected.setHours(12);
    if (expected.getTime() <= harness.now()) {
      expected.setDate(expected.getDate() + 1);
    }
    expect(renderedMs).toBeLessThanOrEqual(expected.getTime());
  });

  it('renders malformed cron records without throwing', async () => {
    const harness = createToolHarness();
    const tool = new CronListTool(harness.cron);
    harness.store.add({ cron: 'garbage', prompt: 'x', recurring: true }, harness.now());

    const output = assertSuccess(await runTool<CronListInput>(tool, {}));

    expect(scrubCronOutput(output)).toMatchInlineSnapshot(`
      "cron_jobs: 1
      id: <id>
      cron: garbage
      humanSchedule: garbage
      prompt: "x"
      nextFireAt: null
      recurring: true
      ageDays: 0.00
      stale: false"
    `);
  });

  it('anchors one-shot nextFireAt at createdAt while the current slot is pending', async () => {
    const createdAt = new Date(2026, 4, 29, 11, 55, 0, 0).getTime();
    const harness = createToolHarness({ now: createdAt });
    const tool = new CronListTool(harness.cron);
    harness.store.add({ cron: '0 12 * * *', prompt: 'noon-pending', recurring: false }, createdAt);
    harness.advance(10 * 60_000);

    const output = assertSuccess(await runTool<CronListInput>(tool, {}));
    const match = /^nextFireAt: (.+)$/m.exec(output);
    expect(match).not.toBeNull();

    const expectedTodayNoon = new Date(createdAt);
    expectedTodayNoon.setHours(12, 0, 0, 0);
    expect(Date.parse(match![1]!)).toBe(expectedTodayNoon.getTime());
  });

  it('reports the current pending jitter window instead of skipping to the next period', async () => {
    const anchor = new Date(2026, 4, 29, 8, 35, 0, 0).getTime();
    const harness = createToolHarness({ now: anchor, noJitter: false });
    const tool = new CronListTool(harness.cron);
    harness.store.adopt({
      id: 'ffffffff',
      cron: '*/5 * * * *',
      prompt: 'pending-jitter',
      createdAt: harness.now(),
      recurring: true,
    });
    harness.advance(5 * 60_000 + 1_000);

    const output = assertSuccess(await runTool<CronListInput>(tool, {}));
    const match = /^nextFireAt: (.+)$/m.exec(output);
    expect(match).not.toBeNull();
    const renderedMs = Date.parse(match![1]!);

    expect(renderedMs - harness.now()).toBeGreaterThanOrEqual(0);
    expect(renderedMs - harness.now()).toBeLessThanOrEqual(60_000);
  });

  it('truncates prompts over 200 UTF-8 bytes', async () => {
    const harness = createToolHarness();
    const tool = new CronListTool(harness.cron);
    const longPrompt = 'x'.repeat(300);
    harness.store.add({ cron: '*/5 * * * *', prompt: longPrompt, recurring: true }, harness.now());

    const output = assertSuccess(await runTool<CronListInput>(tool, {}));
    const promptMatch = /^prompt: (.+)$/m.exec(output);

    expect(promptMatch).not.toBeNull();
    expect(promptMatch![1]!.endsWith(`${TRUNCATED}"`)).toBe(true);
    expect(promptMatch![1]!.length).toBeLessThan(longPrompt.length);
  });

  it('walks back to a UTF-8 character boundary when truncating prompts', async () => {
    const harness = createToolHarness();
    const tool = new CronListTool(harness.cron);
    const cjkPrompt = '\u4f60'.repeat(100);
    harness.store.add({ cron: '*/5 * * * *', prompt: cjkPrompt, recurring: true }, harness.now());

    const output = assertSuccess(await runTool<CronListInput>(tool, {}));
    const promptMatch = /^prompt: (.+)$/m.exec(output);
    expect(promptMatch).not.toBeNull();
    const rendered = promptMatch![1]!;

    expect(rendered.endsWith(`${TRUNCATED}"`)).toBe(true);
    expect(rendered).not.toContain('\ufffd');
    const stripped = rendered.replace(/^"|\\u2026\(truncated\)"$/g, '');
    expect(stripped.length).toBeGreaterThan(0);
  });
});

describe('renderCronFireXml', () => {
  it('escapes attribute ampersands and quotes while leaving the prompt body verbatim', () => {
    const origin: CronJobOrigin = {
      kind: 'cron_job',
      jobId: 'job&"id',
      cron: '*/5 & " * * *',
      recurring: true,
      coalescedCount: 2,
      stale: false,
    };

    const xml = renderCronFireXml(origin, 'body & " < stays raw');

    expect(xml).toContain('jobId="job&amp;&quot;id"');
    expect(xml).toContain('cron="*/5 &amp; &quot; * * *"');
    expect(xml).toContain('<prompt>\nbody & " < stays raw\n</prompt>');
  });

  it('preserves newlines in the prompt body', () => {
    const origin: CronJobOrigin = {
      kind: 'cron_job',
      jobId: 'deadbeef',
      cron: '0 9 * * *',
      recurring: false,
      coalescedCount: 1,
      stale: true,
    };

    const xml = renderCronFireXml(origin, 'line 1\nline 2');

    expect(xml).toBe(
      [
        '<cron-fire jobId="deadbeef" cron="0 9 * * *" recurring="false" coalescedCount="1" stale="true">',
        '<prompt>',
        'line 1\nline 2',
        '</prompt>',
        '</cron-fire>',
      ].join('\n'),
    );
  });
});
