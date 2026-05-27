/**
 * Tests for `tools/cron/cron-delete.ts`.
 *
 * Same harness as `cron-create.test.ts` / `cron-list.test.ts`: a tiny
 * Agent stub exposes only `turn` + `telemetry` (the slices the manager
 * actually touches), and `ClockSources` is injected so nothing in the
 * test relies on the system clock.
 *
 * The behaviours under test mirror the contract documented in
 * `cron-delete.ts`:
 *
 *   1. A real deletion drains the store, returns a success message, and
 *      emits exactly one `cron_deleted` telemetry event keyed on the
 *      task id.
 *   2. A delete of a well-formed-but-missing id is reported as an error
 *      (isError: true) with a "no cron job with id …" message, and
 *      emits no telemetry.
 *   3. Malformed ids (uppercase, too short, non-hex, empty) never reach
 *      the store; the tool returns an error that names the constraint.
 *      No store mutation, no telemetry.
 *
 * These cases together pin the "report-and-correct" contract: the model
 * sees a failure on every code path that would otherwise be a silent
 * no-op.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '../../../src/agent';
import type { PromptOrigin } from '../../../src/agent/context/types';
import { CronManager } from '../../../src/agent/cron/manager';
import type { ClockSources } from '../../../src/tools/cron/clock';
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

// Same wall anchor as the sibling cron tests for cross-file
// comparability of any timing-derived assertions.
const WALL_ANCHOR = 1_700_000_000_000;

interface SteerCall {
  readonly content: readonly ContentPart[];
  readonly origin: PromptOrigin;
}
interface TelemetryCall {
  readonly event: string;
  readonly props: unknown;
}

interface AgentStub {
  readonly agent: Agent;
  readonly steerCalls: SteerCall[];
  readonly telemetryCalls: TelemetryCall[];
}

function createAgentStub(): AgentStub {
  const steerCalls: SteerCall[] = [];
  const telemetryCalls: TelemetryCall[] = [];
  const turn = {
    get hasActiveTurn(): boolean {
      return false;
    },
    steer: (content: readonly ContentPart[], origin: PromptOrigin) => {
      steerCalls.push({ content, origin });
      return 42;
    },
  };
  const telemetry = {
    track: (event: string, props: unknown) => {
      telemetryCalls.push({ event, props });
    },
  };
  const agent = { turn, telemetry } as unknown as Agent;
  return { agent, steerCalls, telemetryCalls };
}

/**
 * Frozen-wall clock. CronDelete does not read `wallNow()` itself, but
 * the manager's `isStale` path (unused here) and `store.add(nowMs, …)`
 * (used during seeding) do — so we pin one value and reuse it.
 */
function createClocks(wall = WALL_ANCHOR): ClockSources {
  return {
    wallNow: () => wall,
    monoNowMs: () => 1_000_000,
  };
}

interface Harness {
  readonly stub: AgentStub;
  readonly manager: CronManager;
  readonly tool: CronDeleteTool;
}

function makeHarness(): Harness {
  const stub = createAgentStub();
  const manager = new CronManager(stub.agent, {
    clocks: createClocks(),
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

    expect(out).toBe(`Deleted cron job ${task.id}.`);
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
    const result = await runTool(tool, { id: '0123abcd' });
    const msg = assertError(result);
    expect(msg).toBe('No cron job with id 0123abcd.');

    expect(manager.store.list()).toHaveLength(0);
    expect(stub.telemetryCalls).toHaveLength(0);
  });

  it('rejects an uppercase id (format check, no store mutation)', async () => {
    const { stub, manager, tool } = makeHarness();
    // Seed a real task so we can confirm the malformed id never reaches
    // the store. (Even though the seeded id won't collide with the
    // uppercase one, this guards against a regression that bypasses
    // the format check entirely and somehow clears the store.)
    manager.store.add(
      { cron: '*/5 * * * *', prompt: 'hi', recurring: true },
      manager.clocks.wallNow(),
    );

    const msg = assertError(await runTool(tool, { id: 'ABCD1234' }));
    expect(msg).toContain('must be 8 lowercase hex');

    expect(manager.store.list()).toHaveLength(1);
    expect(stub.telemetryCalls).toHaveLength(0);
  });

  it('rejects a too-short id', async () => {
    const { stub, manager, tool } = makeHarness();
    const msg = assertError(await runTool(tool, { id: 'abc' }));
    expect(msg).toContain('must be 8 lowercase hex');

    expect(manager.store.list()).toHaveLength(0);
    expect(stub.telemetryCalls).toHaveLength(0);
  });

  it('rejects a non-hex id of the right length', async () => {
    const { stub, manager, tool } = makeHarness();
    const msg = assertError(await runTool(tool, { id: 'zzzzzzzz' }));
    expect(msg).toContain('must be 8 lowercase hex');

    expect(manager.store.list()).toHaveLength(0);
    expect(stub.telemetryCalls).toHaveLength(0);
  });

  it('rejects an empty id', async () => {
    const { stub, manager, tool } = makeHarness();
    const msg = assertError(await runTool(tool, { id: '' }));
    expect(msg).toContain('must be 8 lowercase hex');

    expect(manager.store.list()).toHaveLength(0);
    expect(stub.telemetryCalls).toHaveLength(0);
  });
});
