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
    expect(out).toBe('cron_jobs: 0\nNo cron jobs scheduled.');
  });

  it('renders a single recurring task with all expected columns', async () => {
    const { manager, tool } = makeHarness();
    const nowMs = manager.clocks.wallNow();
    manager.store.add(
      { cron: '*/5 * * * *', prompt: 'hi', recurring: true },
      nowMs,
    );

    const out = assertSuccess(await runTool(tool, {}));

    // Header — single task.
    expect(out.startsWith('cron_jobs: 1\n')).toBe(true);
    // No `---` separator for one record.
    expect(out).not.toContain('\n---\n');

    // Field-by-field. id is 8 hex, nextFireAt is an ISO timestamp,
    // ageDays is exactly 0.00 (we set createdAt = wallNow), stale is
    // false (recurring, but only 0 days old).
    expect(out).toMatch(/^id: [0-9a-f]{8}$/m);
    expect(out).toMatch(/^cron: \*\/5 \* \* \* \*$/m);
    expect(out).toMatch(/^humanSchedule: every 5 minutes$/m);
    expect(out).toMatch(
      /^nextFireAt: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/m,
    );
    expect(out).toMatch(/^recurring: true$/m);
    expect(out).toMatch(/^durable: false$/m);
    expect(out).toMatch(/^ageDays: 0\.00$/m);
    expect(out).toMatch(/^stale: false$/m);
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

    expect(out.startsWith('cron_jobs: 2\n')).toBe(true);
    // Exactly one separator between the two records.
    expect(out.split('\n---\n')).toHaveLength(2);
    // First record's cron precedes the second's in insertion order.
    const firstIdx = out.indexOf('cron: */5 * * * *');
    const secondIdx = out.indexOf('cron: 0 12 * * *');
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    // Recurring flag flips correctly per record.
    expect(out).toMatch(/^recurring: true$/m);
    expect(out).toMatch(/^recurring: false$/m);
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
    expect(out).toMatch(/^stale: true$/m);
    // Spot-check ageDays is the expected ~8.00 — formatted via
    // toFixed(2) so the exact 8.00 string is deterministic.
    expect(out).toMatch(/^ageDays: 8\.00$/m);
  });

  it('reports recurring=false for one-shots; jittered nextFireAt is at-or-before the ideal', async () => {
    // Use `0 12 * * *` so the ideal fire lands on a `:00` minute,
    // which is the one place one-shot jitter actually pulls forward
    // (any other minute is passed through verbatim).
    //
    // KIMI_CRON_NO_JITTER is set in beforeEach, so the jittered
    // value equals the ideal: that satisfies "at-or-before" without
    // making the test sensitive to the per-task deterministic offset.
    const { manager, tool } = makeHarness();
    const nowMs = manager.clocks.wallNow();
    const task = manager.store.add(
      { cron: '0 12 * * *', prompt: 'noon', recurring: false },
      nowMs,
    );

    const out = assertSuccess(await runTool(tool, {}));
    expect(out).toMatch(/^recurring: false$/m);

    // Parse the rendered nextFireAt and confirm it is at-or-before
    // the next ideal noon following `nowMs`.
    const match = /^nextFireAt: (.+)$/m.exec(out);
    expect(match).not.toBeNull();
    const renderedMs = Date.parse(match![1]!);
    expect(Number.isFinite(renderedMs)).toBe(true);

    // Recompute the unjittered "next noon" the same way the tool
    // does. Local-time noon is correct because cron expressions
    // evaluate in local time per `cron-expr.ts`.
    const expected = new Date(nowMs);
    expected.setSeconds(0, 0);
    expected.setMinutes(0);
    expected.setHours(12);
    if (expected.getTime() <= nowMs) {
      expected.setDate(expected.getDate() + 1);
    }
    expect(renderedMs).toBeLessThanOrEqual(expected.getTime());

    // Sanity: the id round-trips.
    expect(out).toContain(`id: ${task.id}`);
  });

  it('renders malformed cron as raw / fallback humanSchedule / null nextFireAt without throwing', async () => {
    const { manager, tool } = makeHarness();
    // `store.add` does NOT validate — that's the seam we're using to
    // simulate "this slipped past CronCreate". The tool must render
    // safely instead of letting parseCronExpression escape.
    const nowMs = manager.clocks.wallNow();
    manager.store.add(
      { cron: 'garbage', prompt: 'x', recurring: true },
      nowMs,
    );

    const out = assertSuccess(await runTool(tool, {}));
    // Raw cron survives the failed parse.
    expect(out).toMatch(/^cron: garbage$/m);
    // humanSchedule falls back to the raw expression.
    expect(out).toMatch(/^humanSchedule: garbage$/m);
    // nextFireAt is the literal string null (no ISO render).
    expect(out).toMatch(/^nextFireAt: null$/m);
  });
});
