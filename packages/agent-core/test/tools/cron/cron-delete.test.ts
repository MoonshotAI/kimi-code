/**
 * Tests for `tools/cron/cron-delete.ts`. Pins the report-and-correct
 * contract: every code path that would otherwise be a silent no-op
 * (missing id, malformed id) reports an error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CronManager } from '../../../src/agent/cron/manager';
import {
  CronDeleteTool,
  type CronDeleteInput,
} from '../../../src/tools/cron/cron-delete';
import { CRON_DELETED } from '../../../src/tools/cron/telemetry-events';
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
  readonly tool: CronDeleteTool;
}

function makeHarness(): Harness {
  const stub = createAgentStub();
  const manager = new CronManager(stub.agent, {
    clocks: createClocks().clocks,
    pollIntervalMs: null,
  });
  const tool = new CronDeleteTool(manager);
  return { stub, manager, tool };
}

async function runTool(
  tool: CronDeleteTool,
  input: CronDeleteInput,
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

describe('CronDeleteTool', () => {
  beforeEach(() => {
    // Disable jitter — irrelevant to delete behaviour but keeps the
    // manager construction path consistent with the create / list
    // tests, in case a later assertion grows to read nextFireAt.
    vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('deletes an existing task, drains the store, and emits cron_deleted', async () => {
    const { stub, manager, tool } = makeHarness();
    // Seed via the store directly so the test is independent of
    // CronCreate's validation surface.
    const task = manager.store.add(
      { cron: '*/5 * * * *', prompt: 'hi', recurring: true },
      manager.clocks.wallNow(),
    );
    expect(manager.store.list()).toHaveLength(1);

    const out = assertSuccess(await runTool(tool, { id: task.id }));

    expect(scrubCronOutput(out)).toMatchInlineSnapshot(
      `"Deleted cron job <id>."`,
    );
    expect(manager.store.list()).toHaveLength(0);

    // Exactly one telemetry event, keyed on the deleted id.
    expect(stub.telemetryCalls).toHaveLength(1);
    expect(stub.telemetryCalls[0]!.event).toBe(CRON_DELETED);
    expect(stub.telemetryCalls[0]!.props).toEqual({ task_id: task.id });

    // The delete tool never steers — guard against an accidental wiring
    // mistake that would inject the prompt at delete time.
    expect(stub.steerCalls).toHaveLength(0);
  });

  it('reports an error when the id is well-formed but absent, with no telemetry', async () => {
    const { stub, manager, tool } = makeHarness();
    // No tasks seeded — the lookup miss is the path under test.
    const msg = assertError(await runTool(tool, { id: '0123abcd' }));
    expect(msg).toMatchInlineSnapshot(`"No cron job with id 0123abcd."`);

    expect(manager.store.list()).toHaveLength(0);
    expect(stub.telemetryCalls).toHaveLength(0);
  });

  it('rejects an uppercase id (format check, no store mutation)', async () => {
    const { stub, manager, tool } = makeHarness();
    // Seed a real task so we can confirm the malformed id never reaches
    // the store. (The seeded id won't collide with the uppercase one,
    // but this guards against a regression that bypasses the format
    // check entirely and somehow clears the store.)
    manager.store.add(
      { cron: '*/5 * * * *', prompt: 'hi', recurring: true },
      manager.clocks.wallNow(),
    );

    const msg = assertError(await runTool(tool, { id: 'ABCD1234' }));
    expect(msg).toMatchInlineSnapshot(
      `"Invalid cron job id "ABCD1234" — must be 8 lowercase hex characters."`,
    );

    expect(manager.store.list()).toHaveLength(1);
    expect(stub.telemetryCalls).toHaveLength(0);
  });

  it('rejects a too-short id', async () => {
    const { stub, manager, tool } = makeHarness();
    const msg = assertError(await runTool(tool, { id: 'abc' }));
    expect(msg).toMatchInlineSnapshot(
      `"Invalid cron job id "abc" — must be 8 lowercase hex characters."`,
    );

    expect(manager.store.list()).toHaveLength(0);
    expect(stub.telemetryCalls).toHaveLength(0);
  });

  it('rejects a non-hex id of the right length', async () => {
    const { stub, manager, tool } = makeHarness();
    const msg = assertError(await runTool(tool, { id: 'zzzzzzzz' }));
    expect(msg).toMatchInlineSnapshot(
      `"Invalid cron job id "zzzzzzzz" — must be 8 lowercase hex characters."`,
    );

    expect(manager.store.list()).toHaveLength(0);
    expect(stub.telemetryCalls).toHaveLength(0);
  });

  it('rejects an empty id', async () => {
    const { stub, manager, tool } = makeHarness();
    const msg = assertError(await runTool(tool, { id: '' }));
    expect(msg).toMatchInlineSnapshot(
      `"Invalid cron job id "" — must be 8 lowercase hex characters."`,
    );

    expect(manager.store.list()).toHaveLength(0);
    expect(stub.telemetryCalls).toHaveLength(0);
  });
});
