/**
 * P1.9 — Session-level cron end-to-end smoke test.
 *
 * Every other Phase-1 test in this directory checks one slice of the
 * cron stack: the scheduler against a hand-rolled task source
 * (`tools/cron/scheduler.test.ts`), the manager against a stubbed Agent
 * (`manager.test.ts`), or the Agent <-> ToolManager wiring
 * (`agent-integration.test.ts`). What none of them covers is the full
 * pipeline as it runs in production:
 *
 *   `CronCreateTool.resolveExecution(...).execute(...)`
 *      ↓
 *   `SessionCronStore.add(...)` on the real `agent.cron.store`
 *      ↓
 *   `CronScheduler.tick()` (driven manually, under an injected clock)
 *      ↓
 *   `CronManager.handleFire(...)`
 *      ↓
 *   `agent.turn.steer(content, CronJobOrigin)` on the real turn
 *
 * This file exercises that whole path through the real `AgentTestContext`
 * harness and asserts the contract documented in todo-cron.md §9 P1.9:
 *
 *   "Inject a mock ClockSources, CronCreate one recurring=true,
 *    cron='*\/5 * * * *', advance 15 minutes, verify steer was called
 *    exactly once with coalescedCount=3 and a full CronJobOrigin."
 *
 * ── Clock injection
 *
 * The Agent constructor eagerly builds a `CronManager` against
 * `SYSTEM_CLOCKS` (modulo the `KIMI_CRON_CLOCK` env hooks). There is no
 * production-side configuration knob to substitute a mock clock at that
 * level — and adding one (`AgentConfig.cron`) is out of scope for P1.9.
 *
 * Instead this test exercises the documented test-only escape hatch: we
 * stop the auto-built manager, replace `agent.cron` with one wired to a
 * mock `ClockSources`, and re-start it with `pollIntervalMs: null` so we
 * drive `tick()` deterministically rather than racing setInterval. The
 * `as any` cast is intentional — `readonly cron` is the right shape for
 * production callers, and the swap is bounded to test setup.
 *
 * ── coalescedCount = 3 calibration
 *
 * Why exactly 3? The scheduler computes `coalescedCount` by enumerating
 * the cron expression's ideal fires that fall in `(firstFire - ε, now]`
 * starting from `firstFire = computeNextCronRun(parsed, baseFromMs)`
 * where `baseFromMs = createdAt`. The expression `*\/5 * * * *`
 * matches every 5 minutes, and `computeNextCronRun` returns the next
 * match *strictly after* its `fromMs` argument.
 *
 *   createdAt = 12:00:00.000
 *   now       = 12:15:00.000
 *   firstFire = computeNextCronRun(parsed, 12:00:00) = 12:05:00
 *   countCoalesced:
 *     count=1, cursor=12:05:00 → next=12:10:00 ≤ 12:15:00 → count=2
 *     count=2, cursor=12:10:00 → next=12:15:00 ≤ 12:15:00 → count=3
 *     count=3, cursor=12:15:00 → next=12:20:00 >  12:15:00 → stop
 *   → coalescedCount = 3
 *
 * We anchor at noon **local time** because `cron-expr` matches on local
 * fields (`Date.getHours()` etc.); a UTC anchor would shift the result
 * by the host's UTC offset. Using `new Date(y, m, d, h, ...)` keeps the
 * count deterministic regardless of where this test runs.
 *
 * ── Jitter
 *
 * `KIMI_CRON_NO_JITTER=1` is set so the actual fire lands at the ideal
 * 12:05:00 and any future change to the jitter window can't push the
 * fire past our 15-minute advance. The `coalescedCount` math itself is
 * jitter-independent (the count is derived from the unjittered ideal
 * schedule), but pinning jitter off keeps the test robust against
 * unrelated jitter refactors.
 *
 * ── Steer interception
 *
 * We wrap `agent.turn.steer` with a spy that captures `(content, origin)`
 * before delegating to the real implementation. The real `steer` is
 * involved deliberately — it writes a `turn.steer` record and launches a
 * turn (since no turn is active, the scripted-generate harness will be
 * asked to produce a response). Wrapping rather than replacing keeps the
 * production code path live; if a regression in `handleFire` ever
 * stopped calling `steer`, the spy's empty array would surface it
 * exactly the way a missed wire would in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CronManager } from '../../../src/agent/cron';
import type { ClockSources } from '../../../src/tools/cron/clock';
import { CronCreateTool } from '../../../src/tools/cron/cron-create';
import { CronDeleteTool } from '../../../src/tools/cron/cron-delete';
import { CronListTool } from '../../../src/tools/cron/cron-list';
import type { ExecutableToolOutput } from '../../../src/loop/types';
import { testAgent, type AgentTestContext } from '../harness/agent';

// Anchor wall-clock to 12:00:00.000 local time on a fixed date. See the
// "coalescedCount = 3 calibration" note in the file header for why local
// time matters — the cron parser uses local fields, so an explicit
// `new Date(y, m, d, h, ...)` is the only way to land the test on a
// known minute regardless of the host's timezone.
const LOCAL_ANCHOR_MS = new Date(2024, 5, 1, 12, 0, 0, 0).getTime();

/**
 * Coerce an `ExecutableToolOutput` (string | ContentPart[]) into a
 * single string. The cron tools we exercise always return a string body,
 * but the type union forces us to handle the structured-content path —
 * doing so via JSON keeps assertions safe against a future tool that
 * starts returning rich content without crashing on the typescript-
 * eslint `no-base-to-string` rule.
 */
function outputText(out: ExecutableToolOutput): string {
  return typeof out === 'string' ? out : JSON.stringify(out);
}

interface MockClockHandle {
  readonly clocks: ClockSources;
  advance(ms: number): void;
  now(): number;
}

function createMockClocks(initial: number): MockClockHandle {
  let wall = initial;
  // Monotonic only ever advances; we drive it from the same `advance(...)`
  // calls so the scheduler's monoNowMs (used for any future poll cadence
  // / lock heartbeat) stays consistent with the wall clock the test
  // controls.
  let mono = 1_000_000;
  return {
    clocks: {
      wallNow: () => wall,
      monoNowMs: () => mono,
    },
    advance: (ms) => {
      wall += ms;
      mono += ms;
    },
    now: () => wall,
  };
}

describe('Cron — session E2E (P1.9)', () => {
  let ctx: AgentTestContext;

  beforeEach(() => {
    // Pin jitter off so the recurring fire lands at the ideal 12:05:00
    // mark (not 12:05:00 + up-to-30s) and the 15-minute advance is more
    // than enough to clear it. Note: `coalescedCount` is computed from
    // the unjittered schedule, so jitter has no effect on the count
    // itself — this flag is belt-and-braces against any future refactor
    // that widens the jitter window past 10 minutes.
    vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
    ctx = testAgent();
  });

  afterEach(async () => {
    // The harness's `onTestFinished` cleanup already calls
    // `agent.cron.stop()`, but doing it here as well keeps the test
    // self-contained against future harness changes and ensures the
    // SIGUSR1 handler (if any) is unbound before the next test.
    await ctx.agent.cron.stop();
    vi.unstubAllEnvs();
  });

  it('recurring */5 task advances 15min → exactly one steer with coalescedCount=3', async () => {
    // Swap the auto-built CronManager (which uses SYSTEM_CLOCKS) for one
    // bound to our mock clock. The `as any` cast is the documented
    // test-only escape hatch — Agent.cron is `readonly` precisely
    // because production code must never overwrite it; tests are the
    // only legitimate exception.
    await ctx.agent.cron.stop();
    const harness = createMockClocks(LOCAL_ANCHOR_MS);
    (ctx.agent as unknown as { cron: CronManager }).cron = new CronManager(
      ctx.agent,
      {
        clocks: harness.clocks,
        // `null` → no setInterval; we drive `tick()` ourselves to keep
        // the test free of timing races.
        pollIntervalMs: null,
      },
    );
    ctx.agent.cron.start();

    // Spy on agent.turn.steer. We wrap rather than replace so the real
    // steer logic still runs (and the `turn.steer` record is written /
    // a turn is launched against the scripted-generate harness). A pure
    // replacement would silence interesting failure modes — e.g. a
    // regression that emits the wrong record type but still calls
    // handleFire.
    const steerCalls: Array<{
      readonly content: readonly unknown[];
      readonly origin: unknown;
    }> = [];
    const originalSteer = ctx.agent.turn.steer.bind(ctx.agent.turn);
    (ctx.agent.turn as unknown as { steer: typeof ctx.agent.turn.steer }).steer =
      (content, origin) => {
        steerCalls.push({ content, origin });
        return originalSteer(content, origin);
      };

    // Schedule via the full tool surface — the scheduling path goes
    // through validation (parse, 5-year window, cap, byte length) just
    // like the LLM-driven path. A back-door `store.add(...)` would
    // bypass `emitScheduled` telemetry and skip the byte-length /
    // expression checks; that would not be the production code path
    // this commit is meant to smoke.
    const createTool = new CronCreateTool(ctx.agent.cron);
    const execution = createTool.resolveExecution({
      cron: '*/5 * * * *',
      prompt: 'cron-fired prompt',
      recurring: true,
      durable: false,
    });
    if (execution.isError === true) {
      throw new Error(
        `CronCreate unexpectedly errored: ${outputText(execution.output)}`,
      );
    }
    const createResult = await execution.execute({
      turnId: 'p19-turn',
      toolCallId: 'p19-call',
      signal: new AbortController().signal,
    });
    expect(createResult.isError ?? false).toBe(false);
    expect(ctx.agent.cron.store.list().length).toBe(1);

    // Advance 15 minutes — exactly three ideal */5 fires across the gap
    // (12:05, 12:10, 12:15). See the file header for the calibration
    // derivation.
    harness.advance(15 * 60_000);
    ctx.agent.cron.tick();

    // ── Steer was called exactly once ─────────────────────────────────
    expect(steerCalls.length).toBe(1);
    const fire = steerCalls[0]!;

    // ── Content carries the user prompt verbatim ─────────────────────
    expect(fire.content).toEqual([{ type: 'text', text: 'cron-fired prompt' }]);

    // ── Origin carries the full CronJobOrigin contract ───────────────
    expect(fire.origin).toMatchObject({
      kind: 'cron_job',
      cron: '*/5 * * * *',
      recurring: true,
      coalescedCount: 3,
      stale: false,
    });
    // jobId comes back as the same 8-hex shape the store guarantees.
    const origin = fire.origin as { readonly jobId: string };
    expect(typeof origin.jobId).toBe('string');
    expect(origin.jobId).toMatch(/^[0-9a-f]{8}$/);
  });

  it('CronCreate → CronList → CronDelete cycle returns sensible output', async () => {
    // Optional second case from the P1.9 plan: prove the three-tool
    // surface composes correctly end-to-end on the real manager. No
    // clock manipulation needed — list/delete are time-invariant.
    const createTool = new CronCreateTool(ctx.agent.cron);
    const listTool = new CronListTool(ctx.agent.cron);
    const deleteTool = new CronDeleteTool(ctx.agent.cron);
    const ctxArgs = {
      turnId: 'p19-tools',
      toolCallId: 'p19-tools-call',
      signal: new AbortController().signal,
    };

    // 1. Create.
    const createExec = createTool.resolveExecution({
      cron: '*/10 * * * *',
      prompt: 'noop',
      recurring: true,
      durable: false,
    });
    if (createExec.isError === true) {
      throw new Error(`CronCreate failed: ${outputText(createExec.output)}`);
    }
    const createOut = await createExec.execute(ctxArgs);
    expect(createOut.isError ?? false).toBe(false);
    const idMatch = /id:\s*([0-9a-f]{8})/.exec(outputText(createOut.output));
    expect(idMatch).not.toBeNull();
    const id = idMatch![1]!;

    // 2. List — should show one record carrying the id we just got.
    const listExec = listTool.resolveExecution({});
    if (listExec.isError === true) {
      throw new Error(`CronList failed: ${outputText(listExec.output)}`);
    }
    const listOut = await listExec.execute(ctxArgs);
    expect(listOut.isError ?? false).toBe(false);
    const listText = outputText(listOut.output);
    expect(listText).toContain('cron_jobs: 1');
    expect(listText).toContain(`id: ${id}`);
    expect(listText).toContain('cron: */10 * * * *');

    // 3. Delete the task we just created.
    const deleteExec = deleteTool.resolveExecution({ id });
    if (deleteExec.isError === true) {
      throw new Error(`CronDelete failed: ${outputText(deleteExec.output)}`);
    }
    const deleteOut = await deleteExec.execute(ctxArgs);
    expect(deleteOut.isError ?? false).toBe(false);
    expect(outputText(deleteOut.output)).toContain(`Deleted cron job ${id}`);

    // 4. List again — empty.
    const listExec2 = listTool.resolveExecution({});
    if (listExec2.isError === true) {
      throw new Error(`CronList failed: ${outputText(listExec2.output)}`);
    }
    const listOut2 = await listExec2.execute(ctxArgs);
    expect(listOut2.isError ?? false).toBe(false);
    expect(outputText(listOut2.output)).toContain('cron_jobs: 0');
    expect(outputText(listOut2.output)).toContain('No cron jobs scheduled.');
  });
});
