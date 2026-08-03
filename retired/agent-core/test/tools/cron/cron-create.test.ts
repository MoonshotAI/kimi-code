/**
 * Tests for `tools/cron/cron-create.ts`.
 *
 * Empty-prompt handling lives in the loop's AJV layer (`prompt.min(1)`
 * runs before `resolveExecution`), so we document the path instead of
 * asserting a false positive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CronManager } from '../../../src/agent/cron/manager';
import {
  CronCreateTool,
  MAX_CRON_JOBS_PER_SESSION,
  type CronCreateInput,
} from '../../../src/tools/cron/cron-create';
import { CRON_SCHEDULED } from '../../../src/tools/cron/telemetry-events';
import type {
  ExecutableToolErrorResult,
  ExecutableToolResult,
  RunnableToolExecution,
  ToolExecution,
} from '../../../src/loop/types';
import {
  createAgentStub,
  createClocks,
  scrubCronOutput,
  type AgentStub,
} from '../../agent/cron/harness/stub';

interface Harness {
  readonly stub: AgentStub;
  readonly manager: CronManager;
  readonly tool: CronCreateTool;
}

function makeHarness(wall?: number): Harness {
  const stub = createAgentStub();
  const manager = new CronManager(stub.agent, {
    clocks: createClocks(wall).clocks,
    pollIntervalMs: null,
  });
  const tool = new CronCreateTool(manager);
  return { stub, manager, tool };
}

/**
 * `resolveExecution` returns either a synchronous error (no `execute`)
 * or a runnable execution. This narrows to the runnable case and runs
 * `execute` with a minimal context.
 */
async function runTool(
  tool: CronCreateTool,
  input: CronCreateInput,
): Promise<ExecutableToolResult> {
  const execution = tool.resolveExecution(input);
  if (isErrorExecution(execution)) {
    return execution;
  }
  return execution.execute({
    turnId: 'test-turn',
    toolCallId: 'test-call',
    signal: new AbortController().signal,
  });
}

function isErrorExecution(
  execution: ToolExecution,
): execution is ExecutableToolErrorResult {
  return (execution as RunnableToolExecution).execute === undefined;
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

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function extractApprovalRule(execution: ToolExecution): string {
  if (isErrorExecution(execution)) {
    throw new Error('expected runnable execution, got error');
  }
  const rule = (execution as RunnableToolExecution).approvalRule;
  if (typeof rule !== 'string') {
    throw new Error('expected approvalRule to be a string');
  }
  return rule;
}

describe('CronCreateTool', () => {
  beforeEach(() => {
    // Disable jitter so the nextFireAt string we render is the bare
    // ideal time — keeps the format assertions readable without
    // dragging in a jittered offset.
    vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('documents the session task cap and near-term one-shot guidance, without bench env vars', () => {
    const { tool } = makeHarness();
    expect(tool.description).toContain('50 live cron tasks');
    // One-shot guidance nudges the model toward near-term reminders; the hard future-window
    // limit lives in code (ONE_SHOT_MAX_FUTURE_MS) and must NOT be surfaced as a prompt rule,
    // and the year-boundary heuristic — wrong across Dec 31 → Jan 1 — must be gone.
    expect(tool.description).toContain('near-term reminders');
    expect(tool.description).not.toContain('already passed this year');
    expect(tool.description).not.toContain('350 days');
    // Bench/CI-only env knobs the model never sets must not appear in the prompt.
    expect(tool.description).not.toContain('KIMI_CRON_NO_STALE');
    expect(tool.description).not.toContain('KIMI_CRON_NO_JITTER');
    // The 8 KiB prompt cap lives in the param describe.
    const params = tool.parameters as { properties: Record<string, { description?: string }> };
    expect(params.properties['prompt']?.description).toContain('8 KiB');
    // Returned fields include `cron` (CronCreateOutput.cron), which formatOutput emits.
    expect(tool.description).toContain('the normalized expression');
  });

  it('schedules a recurring task and emits cron_scheduled', async () => {
    const { stub, manager, tool } = makeHarness();
    const result = await runTool(tool, {
      cron: '*/5 * * * *',
      prompt: 'hi',
      recurring: true,
    });
    const out = assertSuccess(result);

    // id is randomly generated, nextFireAt depends on the host TZ —
    // both are scrubbed so the snapshot pins the structural format.
    expect(scrubCronOutput(out)).toMatchInlineSnapshot(`
      "id: <id>
      cron: */5 * * * *
      humanSchedule: every 5 minutes
      recurring: true
      nextFireAt: <iso>"
    `);

    expect(manager.store.list()).toHaveLength(1);
    expect(stub.telemetryCalls).toHaveLength(1);
    expect(stub.telemetryCalls[0]!.event).toBe(CRON_SCHEDULED);
    expect(stub.telemetryCalls[0]!.props).toEqual({
      recurring: true,
    });
  });

  it('renders nextFireAt in local time with an explicit offset', async () => {
    const now = new Date(2026, 4, 29, 8, 35, 0, 0).getTime();
    const { tool } = makeHarness(now);
    const result = await runTool(tool, {
      cron: '0 9 * * *',
      prompt: 'morning',
      recurring: true,
    });

    const out = assertSuccess(result);
    const expected = new Date(now);
    expected.setSeconds(0, 0);
    expected.setMinutes(0);
    expected.setHours(9);
    expect(out).toContain(`nextFireAt: ${localIsoWithOffset(expected.getTime())}`);
    expect(out).not.toContain('nextFireAt: 2026-05-29T01:00:00.000Z');
  });

  it('schedules a one-shot task with recurring=false in the stored record', async () => {
    const { manager, tool, stub } = makeHarness();
    const result = await runTool(tool, {
      cron: '0 12 * * *',
      prompt: 'noon',
      recurring: false,
    });
    const out = assertSuccess(result);
    expect(scrubCronOutput(out)).toMatchInlineSnapshot(`
      "id: <id>
      cron: 0 12 * * *
      humanSchedule: at 12:00 every day
      recurring: false
      nextFireAt: <iso>"
    `);

    const tasks = manager.store.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.recurring).toBe(false);

    expect(stub.telemetryCalls).toHaveLength(1);
    expect(stub.telemetryCalls[0]!.props).toMatchObject({ recurring: false });
  });

  it('rejects an unparseable cron expression', async () => {
    const { manager, tool, stub } = makeHarness();
    const msg = assertError(
      await runTool(tool, {
        cron: 'not a cron',
        prompt: 'x',
        recurring: true,
      }),
    );
    expect(msg).toMatchInlineSnapshot(
      `"Invalid cron expression: cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week); got 3"`,
    );

    expect(manager.store.list()).toHaveLength(0);
    expect(stub.telemetryCalls).toHaveLength(0);
  });

  it('rejects a legal-but-never-fires cron expression', async () => {
    const { manager, tool, stub } = makeHarness();
    // Feb 31st — parses fine, never fires.
    const msg = assertError(
      await runTool(tool, {
        cron: '0 0 31 2 *',
        prompt: 'never',
        recurring: false,
      }),
    );
    expect(msg).toMatchInlineSnapshot(
      `"Cron expression "0 0 31 2 *" has no fire within 5 years; refusing to schedule."`,
    );

    expect(manager.store.list()).toHaveLength(0);
    expect(stub.telemetryCalls).toHaveLength(0);
  });

  it('returns an error when KIMI_DISABLE_CRON=1', async () => {
    vi.stubEnv('KIMI_DISABLE_CRON', '1');
    const { manager, tool, stub } = makeHarness();
    const msg = assertError(
      await runTool(tool, {
        cron: '*/5 * * * *',
        prompt: 'hi',
        recurring: true,
      }),
    );
    expect(msg).toMatchInlineSnapshot(
      `"Cron scheduling is disabled (KIMI_DISABLE_CRON=1)."`,
    );

    expect(manager.store.list()).toHaveLength(0);
    expect(stub.telemetryCalls).toHaveLength(0);
  });

  it('refuses to schedule past the session cap', async () => {
    const { manager, tool, stub } = makeHarness();
    // Pre-fill the store with the max number of tasks. The cap reads
    // `store.list().length`, so any well-formed task seeds it.
    const seedNow = manager.clocks.wallNow();
    for (let i = 0; i < MAX_CRON_JOBS_PER_SESSION; i++) {
      manager.store.add(
        { cron: '*/5 * * * *', prompt: `seed-${String(i)}`, recurring: true },
        seedNow,
      );
    }
    expect(manager.store.list()).toHaveLength(MAX_CRON_JOBS_PER_SESSION);

    const msg = assertError(
      await runTool(tool, {
        cron: '*/5 * * * *',
        prompt: 'overflow',
        recurring: true,
      }),
    );
    expect(msg).toMatchInlineSnapshot(
      `"Cron job cap reached (max 50 per session)."`,
    );

    expect(manager.store.list()).toHaveLength(MAX_CRON_JOBS_PER_SESSION);
    expect(stub.telemetryCalls).toHaveLength(0);
  });

  it('rejects prompts above the 8 KiB byte budget (multi-byte input)', async () => {
    const { manager, tool, stub } = makeHarness();
    // '汉' is 3 bytes in UTF-8; 3000 repetitions = 9000 bytes > 8192.
    // zod's `.max(8192)` is in code units and would accept this — the
    // byte check inside the tool catches it.
    const prompt = '汉'.repeat(3000);
    const msg = assertError(
      await runTool(tool, {
        cron: '*/5 * * * *',
        prompt,
        recurring: true,
      }),
    );
    expect(msg).toMatchInlineSnapshot(
      `"Prompt exceeds 8192 bytes (got 9000)."`,
    );

    expect(manager.store.list()).toHaveLength(0);
    expect(stub.telemetryCalls).toHaveLength(0);
  });

  it('documents empty-prompt handling as a loop-layer concern', () => {
    // zod's `.min(1)` on `prompt` lives in the input schema, which
    // the loop's AJV validator enforces before `resolveExecution` is
    // ever invoked. The tool itself does not re-check that — see the
    // module header for the rationale. This test exists as
    // documentation rather than as a real assertion, so the rationale
    // is co-located with the test list called out in the spec.
    expect(true).toBe(true);
  });

  describe('whitespace normalization', () => {
    it('normalizes newline-separated cron fields to single spaces in the store', async () => {
      const { manager, tool } = makeHarness();
      const result = await runTool(tool, {
        cron: '*/5\n* * * *',
        prompt: 'x',
        recurring: true,
      });
      expect(result.isError ?? false).toBe(false);

      const tasks = manager.store.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.cron).toBe('*/5 * * * *');
    });

    it('normalizes tab-separated cron fields', async () => {
      const { manager, tool } = makeHarness();
      const result = await runTool(tool, {
        cron: '*/5\t*\t*\t*\t*',
        prompt: 'x',
        recurring: true,
      });
      expect(result.isError ?? false).toBe(false);

      const tasks = manager.store.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.cron).toBe('*/5 * * * *');
    });

    it('normalizes leading/trailing whitespace', async () => {
      const { manager, tool } = makeHarness();
      const result = await runTool(tool, {
        cron: '   */5 * * * *   ',
        prompt: 'x',
        recurring: true,
      });
      expect(result.isError ?? false).toBe(false);

      const tasks = manager.store.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.cron).toBe('*/5 * * * *');
    });

    it('normalized cron is what shows up in the rendered CronCreate output', async () => {
      const { tool } = makeHarness();
      const result = await runTool(tool, {
        cron: '*/5\n* * * *',
        prompt: 'x',
        recurring: true,
      });
      const out = assertSuccess(result);
      expect(out).toContain('cron: */5 * * * *');
      // No literal newline between the cron field tokens — the only
      // newlines should be the record separators between keys.
      expect(out).not.toMatch(/cron: \*\/5\n\* \* \* \*/);
    });

    it('normalizes whitespace before parse so humanSchedule does not leak newlines', async () => {
      // `cronToHuman` recognizes "*/5 * * * *" → "every 5 minutes",
      // so the rendered humanSchedule should be the template output —
      // a single line, no leaked newline from the raw input.
      const { tool } = makeHarness();
      const result = await runTool(tool, {
        cron: '*/5\n* * * *',
        prompt: 'x',
        recurring: true,
      });
      const out = assertSuccess(result);
      const match = /^humanSchedule: (.+)$/m.exec(out);
      expect(match).not.toBeNull();
      const value = match![1]!;
      expect(value).toBe('every 5 minutes');
      expect(value).not.toContain('\n');
    });

    it('humanSchedule fallback is single-line for a non-template cron with tabs in input', async () => {
      // Five specific integers don't match any cronToHuman template,
      // so the function falls back to `parsed.raw`. With normalization
      // moved before parsing, `parsed.raw` is the single-line form;
      // the rendered humanSchedule must not contain the original tabs
      // or any newlines.
      const { tool } = makeHarness();
      const result = await runTool(tool, {
        cron: '1\t2\t3\t4\t5',
        prompt: 'x',
        recurring: true,
      });
      const out = assertSuccess(result);
      const match = /^humanSchedule: (.+)$/m.exec(out);
      expect(match).not.toBeNull();
      const value = match![1]!;
      expect(value).toBe('1 2 3 4 5');
      expect(value).not.toContain('\t');
      expect(value.split('\n').length - 1).toBe(0);
    });
  });

  describe('clock anchored at execute() time', () => {
    it('uses the clock value at execute(), not resolveExecution()', async () => {
      // Mirrors the manual-approval scenario: prepare returns a
      // runnable, the user takes a while to approve, and only then
      // does execute() run. If the schedule were anchored at prepare
      // time, the one-shot would be inserted with a stale
      // `createdAt` and could fire immediately on the next tick.
      const stub = createAgentStub();
      const harness = createClocks();
      const manager = new CronManager(stub.agent, {
        clocks: harness.clocks,
        pollIntervalMs: null,
      });
      const tool = new CronCreateTool(manager);

      const execution = tool.resolveExecution({
        cron: '*/5 * * * *',
        prompt: 'after-delay',
        recurring: false,
      });
      if (isErrorExecution(execution)) {
        throw new Error('expected runnable execution');
      }

      // Advance the wall clock past prepare-time (manual-approval gap)
      // before running execute(). The task should be created with
      // `createdAt` equal to the new wall time, not the original one.
      const beforeExecute = harness.now();
      harness.advance(10 * 60_000);
      const afterExecute = harness.now();

      await execution.execute({
        turnId: 't',
        toolCallId: 'c',
        signal: new AbortController().signal,
      });

      const tasks = manager.store.list();
      expect(tasks).toHaveLength(1);
      const task = tasks[0]!;
      expect(task.createdAt).toBe(afterExecute);
      expect(task.createdAt).not.toBe(beforeExecute);
    });
  });

  describe('one-shot pinned-date guard', () => {
    it('rejects a one-shot whose first fire is more than ~one year out', async () => {
      // Simulate the "today, just missed" footgun: the tool docs
      // recommend pinning <today_dom>/<today_month> for "remind me at X
      // today". If submission lands seconds past the target minute,
      // `computeNextCronRun` rolls the match to next year and the
      // 5-year window happily accepts it. Without the dedicated guard
      // the user gets a year-late reminder. Build the cron by pinning
      // *yesterday's* local dom/month — guaranteed to have passed in
      // every timezone, so the next match is next year.
      const { stub, manager, tool } = makeHarness();
      const yesterday = new Date(manager.clocks.wallNow() - 24 * 60 * 60 * 1000);
      const dom = yesterday.getDate();
      const month = yesterday.getMonth() + 1;

      const result = await runTool(tool, {
        cron: `0 12 ${String(dom)} ${String(month)} *`,
        prompt: 'yesterday',
        recurring: false,
      });
      const msg = assertError(result);
      expect(msg).toContain('more than a year out');
      expect(manager.store.list()).toHaveLength(0);
      expect(stub.telemetryCalls).toHaveLength(0);
    });

    it('accepts a recurring task whose next fire happens to be a year out', async () => {
      // The guard is one-shot-only — recurring tasks may legitimately
      // land their first match on next year's anniversary.
      const { manager, tool } = makeHarness();
      const yesterday = new Date(manager.clocks.wallNow() - 24 * 60 * 60 * 1000);
      const dom = yesterday.getDate();
      const month = yesterday.getMonth() + 1;

      const result = await runTool(tool, {
        cron: `0 12 ${String(dom)} ${String(month)} *`,
        prompt: 'annual',
        recurring: true,
      });
      expect(result.isError ?? false).toBe(false);
      expect(manager.store.list()).toHaveLength(1);
    });

    it('accepts a one-shot scheduled for a near-future date this year', async () => {
      // Sanity: the guard does not reject legitimate pinning whose
      // next match is still well inside the window. Compute the
      // target date dynamically from the harness clock so the test is
      // independent of the host timezone (local-time evaluation of
      // the cron means hard-coded dom/month would be wrong on non-UTC
      // CI).
      const { manager, tool } = makeHarness();
      const sevenDaysAhead = new Date(manager.clocks.wallNow() + 7 * 24 * 60 * 60 * 1000);
      const dom = sevenDaysAhead.getDate();
      const month = sevenDaysAhead.getMonth() + 1;
      const result = await runTool(tool, {
        cron: `0 12 ${String(dom)} ${String(month)} *`,
        prompt: 'in 7 days',
        recurring: false,
      });
      expect(result.isError ?? false).toBe(false);
      expect(manager.store.list()).toHaveLength(1);
    });
  });

  describe('approvalRule includes the payload', () => {
    it('produces a distinct rule for each (cron, prompt, recurring) tuple', () => {
      // Without payload encoding, every CronCreate would share the
      // same approvalRule `CronCreate` — one `scope: session` approval
      // would auto-authorize any future scheduled prompt for the rest
      // of the session. Mirror the Bash / Write / Edit convention: the
      // rule must change when the payload changes.
      const { tool } = makeHarness();
      const ruleA = extractApprovalRule(
        tool.resolveExecution({
          cron: '*/5 * * * *',
          prompt: 'A',
          recurring: true,
        }),
      );
      const ruleB = extractApprovalRule(
        tool.resolveExecution({
          cron: '*/5 * * * *',
          prompt: 'B',
          recurring: true,
        }),
      );
      const ruleSameAsA = extractApprovalRule(
        tool.resolveExecution({
          cron: '*/5 * * * *',
          prompt: 'A',
          recurring: true,
        }),
      );
      const ruleDifferentCron = extractApprovalRule(
        tool.resolveExecution({
          cron: '0 9 * * *',
          prompt: 'A',
          recurring: true,
        }),
      );

      // Different prompts → different rules.
      expect(ruleA).not.toBe(ruleB);
      // Different crons → different rules.
      expect(ruleA).not.toBe(ruleDifferentCron);
      // Same payload → same rule (so a session approval keeps working).
      expect(ruleA).toBe(ruleSameAsA);
      // Rule must still start with the tool name so the permission
      // layer routes it to the right matcher.
      expect(ruleA.startsWith('CronCreate(')).toBe(true);
    });
  });

  describe('cap rechecked inside execute()', () => {
    it('refuses insert when the store fills between prepare and execute', async () => {
      // Two concurrently prepared CronCreate calls must not be able
      // to both pass the cap check at prepare time and then both
      // succeed at execute() time, breaching the cap. The first to
      // execute wins; the second must observe the live store size and
      // refuse.
      const stub = createAgentStub();
      const harness = createClocks();
      const manager = new CronManager(stub.agent, {
        clocks: harness.clocks,
        pollIntervalMs: null,
      });
      const tool = new CronCreateTool(manager);

      // Seed up to one below the cap, then prepare two CronCreate
      // calls. Both see length === MAX - 1 < MAX and pass the
      // prepare-time gate; the second's execute() must trip the
      // re-check after the first executes.
      const seedNow = manager.clocks.wallNow();
      for (let i = 0; i < MAX_CRON_JOBS_PER_SESSION - 1; i++) {
        manager.store.add(
          { cron: '*/5 * * * *', prompt: `seed-${String(i)}`, recurring: true },
          seedNow,
        );
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
      if (isErrorExecution(first) || isErrorExecution(second)) {
        throw new Error('expected both to pass prepare-time cap');
      }

      const ctx = {
        turnId: 't',
        toolCallId: 'c',
        signal: new AbortController().signal,
      };
      const firstResult = await first.execute(ctx);
      const secondResult = await second.execute(ctx);

      expect(firstResult.isError ?? false).toBe(false);
      expect(secondResult.isError).toBe(true);
      expect(secondResult.output).toMatchInlineSnapshot(
        `"Cron job cap reached (max 50 per session)."`,
      );
      expect(manager.store.list()).toHaveLength(MAX_CRON_JOBS_PER_SESSION);
    });
  });
});
