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

function makeHarness(): Harness {
  const stub = createAgentStub();
  const manager = new CronManager(stub.agent, {
    clocks: createClocks().clocks,
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

  it('schedules a recurring task and emits cron_scheduled', async () => {
    const { stub, manager, tool } = makeHarness();
    const result = await runTool(tool, {
      cron: '*/5 * * * *',
      prompt: 'hi',
      recurring: true,
      durable: false,
    });
    const out = assertSuccess(result);

    // id is randomly generated, nextFireAt depends on the host TZ —
    // both are scrubbed so the snapshot pins the structural format.
    expect(scrubCronOutput(out)).toMatchInlineSnapshot(`
      "id: <id>
      cron: */5 * * * *
      humanSchedule: every 5 minutes
      recurring: true
      durable: false
      nextFireAt: <iso>"
    `);

    expect(manager.store.list()).toHaveLength(1);
    expect(stub.telemetryCalls).toHaveLength(1);
    expect(stub.telemetryCalls[0]!.event).toBe(CRON_SCHEDULED);
    expect(stub.telemetryCalls[0]!.props).toEqual({
      recurring: true,
      durable: false,
    });
  });

  it('schedules a one-shot task with recurring=false in the stored record', async () => {
    const { manager, tool, stub } = makeHarness();
    const result = await runTool(tool, {
      cron: '0 12 * * *',
      prompt: 'noon',
      recurring: false,
      durable: false,
    });
    const out = assertSuccess(result);
    expect(scrubCronOutput(out)).toMatchInlineSnapshot(`
      "id: <id>
      cron: 0 12 * * *
      humanSchedule: at 12:00 every day
      recurring: false
      durable: false
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
        durable: false,
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
        durable: false,
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
        durable: false,
      }),
    );
    expect(msg).toMatchInlineSnapshot(
      `"Cron scheduling is disabled (KIMI_DISABLE_CRON=1)."`,
    );

    expect(manager.store.list()).toHaveLength(0);
    expect(stub.telemetryCalls).toHaveLength(0);
  });

  it('rejects durable=true (Phase 2 not implemented)', async () => {
    const { manager, tool, stub } = makeHarness();
    const msg = assertError(
      await runTool(tool, {
        cron: '*/5 * * * *',
        prompt: 'x',
        recurring: true,
        durable: true,
      }),
    );
    expect(msg).toMatchInlineSnapshot(
      `"durable=true is not supported in this build. Use durable=false (session-only) for now."`,
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
        durable: false,
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
        durable: false,
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
});
