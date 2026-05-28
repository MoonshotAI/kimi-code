/**
 * Tests for `tools/cron/cron-list.ts`.
 *
 * Tasks are seeded via `manager.store.add(...)` so we can exercise
 * corners CronCreate's validator would never let through (notably the
 * malformed-cron path).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CronManager } from '../../../src/agent/cron/manager';
import {
  CronListTool,
  type CronListInput,
} from '../../../src/tools/cron/cron-list';
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
  WALL_ANCHOR,
  type AgentStub,
} from '../../agent/cron/harness/stub';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface Harness {
  readonly stub: AgentStub;
  readonly manager: CronManager;
  readonly tool: CronListTool;
}

function makeHarness(wall = WALL_ANCHOR): Harness {
  const stub = createAgentStub();
  const manager = new CronManager(stub.agent, {
    clocks: createClocks(wall).clocks,
    pollIntervalMs: null,
  });
  const tool = new CronListTool(manager);
  return { stub, manager, tool };
}

async function runTool(
  tool: CronListTool,
  input: CronListInput,
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

describe('CronListTool', () => {
  beforeEach(() => {
    // Disable jitter so `nextFireAt` is the unmodified ideal — keeps
    // the one-shot-on-`:00` assertion bisectable without needing to
    // reason about a deterministic-but-task-id-dependent offset.
    vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders the empty case with a zero header and no separator', async () => {
    const { tool } = makeHarness();
    const out = assertSuccess(await runTool(tool, {}));
    expect(out).toMatchInlineSnapshot(`
      "cron_jobs: 0
      No cron jobs scheduled."
    `);
  });

  it('renders a single recurring task with all expected columns', async () => {
    const { manager, tool } = makeHarness();
    const nowMs = manager.clocks.wallNow();
    manager.store.add(
      { cron: '*/5 * * * *', prompt: 'hi', recurring: true },
      nowMs,
    );

    const out = assertSuccess(await runTool(tool, {}));

    // ageDays is exactly 0.00 (we set createdAt = wallNow); stale is
    // false (recurring, only 0 days old). id + nextFireAt are scrubbed.
    expect(scrubCronOutput(out)).toMatchInlineSnapshot(`
      "cron_jobs: 1
      id: <id>
      cron: */5 * * * *
      humanSchedule: every 5 minutes
      nextFireAt: <iso>
      recurring: true
      ageDays: 0.00
      stale: false"
    `);
  });

  it('separates multiple records with \\n---\\n in insertion order', async () => {
    const { manager, tool } = makeHarness();
    const nowMs = manager.clocks.wallNow();
    manager.store.add(
      { cron: '*/5 * * * *', prompt: 'first', recurring: true },
      nowMs,
    );
    manager.store.add(
      { cron: '0 12 * * *', prompt: 'second', recurring: false },
      nowMs,
    );

    const out = assertSuccess(await runTool(tool, {}));
    expect(scrubCronOutput(out)).toMatchInlineSnapshot(`
      "cron_jobs: 2
      id: <id>
      cron: */5 * * * *
      humanSchedule: every 5 minutes
      nextFireAt: <iso>
      recurring: true
      ageDays: 0.00
      stale: false
      ---
      id: <id>
      cron: 0 12 * * *
      humanSchedule: at 12:00 every day
      nextFireAt: <iso>
      recurring: false
      ageDays: 0.00
      stale: false"
    `);
  });

  it('flags a recurring task older than 7 days as stale', async () => {
    // Anchor "now" at WALL_ANCHOR; seed the task with createdAt 8
    // days earlier so age > 7 d crosses the stale threshold.
    const { manager, tool } = makeHarness();
    const eightDaysAgo = WALL_ANCHOR - 8 * MS_PER_DAY;
    manager.store.add(
      { cron: '*/5 * * * *', prompt: 'old', recurring: true },
      eightDaysAgo,
    );

    const out = assertSuccess(await runTool(tool, {}));
    // ageDays formatted via toFixed(2) is deterministic at 8.00.
    expect(scrubCronOutput(out)).toMatchInlineSnapshot(`
      "cron_jobs: 1
      id: <id>
      cron: */5 * * * *
      humanSchedule: every 5 minutes
      nextFireAt: <iso>
      recurring: true
      ageDays: 8.00
      stale: true"
    `);
  });

  it('reports recurring=false for one-shots; jittered nextFireAt is at-or-before the ideal', async () => {
    // KIMI_CRON_NO_JITTER is set in beforeEach, so the jittered value
    // equals the ideal: that satisfies "at-or-before" without making
    // the test sensitive to the per-task deterministic offset.
    const { manager, tool } = makeHarness();
    const nowMs = manager.clocks.wallNow();
    manager.store.add(
      { cron: '0 12 * * *', prompt: 'noon', recurring: false },
      nowMs,
    );

    const out = assertSuccess(await runTool(tool, {}));

    // Parse the rendered nextFireAt and confirm it is at-or-before
    // the next ideal noon following `nowMs`. The snapshot scrubs the
    // exact timestamp; this assertion guards the at-or-before bound.
    const match = /^nextFireAt: (.+)$/m.exec(out);
    expect(match).not.toBeNull();
    const renderedMs = Date.parse(match![1]!);
    expect(Number.isFinite(renderedMs)).toBe(true);
    const expected = new Date(nowMs);
    expected.setSeconds(0, 0);
    expected.setMinutes(0);
    expected.setHours(12);
    if (expected.getTime() <= nowMs) {
      expected.setDate(expected.getDate() + 1);
    }
    expect(renderedMs).toBeLessThanOrEqual(expected.getTime());

    expect(scrubCronOutput(out)).toMatchInlineSnapshot(`
      "cron_jobs: 1
      id: <id>
      cron: 0 12 * * *
      humanSchedule: at 12:00 every day
      nextFireAt: <iso>
      recurring: false
      ageDays: 0.00
      stale: false"
    `);
  });

  it('renders malformed cron as raw / fallback humanSchedule / null nextFireAt without throwing', async () => {
    const { manager, tool } = makeHarness();
    // `store.add` does NOT validate — that's the seam we're using to
    // simulate "this slipped past CronCreate".
    const nowMs = manager.clocks.wallNow();
    manager.store.add(
      { cron: 'garbage', prompt: 'x', recurring: true },
      nowMs,
    );

    const out = assertSuccess(await runTool(tool, {}));
    expect(scrubCronOutput(out)).toMatchInlineSnapshot(`
      "cron_jobs: 1
      id: <id>
      cron: garbage
      humanSchedule: garbage
      nextFireAt: null
      recurring: true
      ageDays: 0.00
      stale: false"
    `);
  });
});
