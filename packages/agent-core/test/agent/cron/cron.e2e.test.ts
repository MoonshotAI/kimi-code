/**
 * Session-level cron end-to-end smoke: exercises the full
 * `CronCreateTool → SessionCronStore → CronScheduler → CronManager →
 * agent.turn.steer` pipeline through the real `AgentTestContext`,
 * with a swapped CronManager wired to an injected clock so the
 * `coalescedCount = 3` calibration after a 15-minute advance is
 * deterministic regardless of host TZ.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CronManager } from '../../../src/agent/cron';
import { CronCreateTool } from '../../../src/tools/cron/cron-create';
import { CronDeleteTool } from '../../../src/tools/cron/cron-delete';
import { CronListTool } from '../../../src/tools/cron/cron-list';
import type { ExecutableToolOutput } from '../../../src/loop/types';
import { testAgent, type AgentTestContext } from '../harness/agent';
import { createClocks } from './harness/stub';

// Local-time anchor (cron-expr matches on local fields, so a UTC anchor
// would shift the result by the host's offset). At noon + 15 min the
// `*\/5 * * * *` ideal fires are 12:05/12:10/12:15 → coalescedCount=3.
const LOCAL_ANCHOR_MS = new Date(2024, 5, 1, 12, 0, 0, 0).getTime();

/**
 * Coerce an `ExecutableToolOutput` (string | ContentPart[]) into a
 * single string. The cron tools always return a string body, but the
 * union forces us to handle the structured-content path — JSON keeps
 * future-tool assertions safe and the `no-base-to-string` rule happy.
 */
function outputText(out: ExecutableToolOutput): string {
  return typeof out === 'string' ? out : JSON.stringify(out);
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
    await ctx.agent.cron?.stop();
    vi.unstubAllEnvs();
  });

  it('recurring */5 task advances 15min → exactly one steer with coalescedCount=3', async () => {
    // Swap the auto-built CronManager (which uses SYSTEM_CLOCKS) for one
    // bound to our mock clock. The `as any` cast is the documented
    // test-only escape hatch — Agent.cron is `readonly` precisely
    // because production code must never overwrite it; tests are the
    // only legitimate exception.
    await ctx.agent.cron!.stop();
    const harness = createClocks(LOCAL_ANCHOR_MS);
    (ctx.agent as unknown as { cron: CronManager }).cron = new CronManager(
      ctx.agent,
      {
        clocks: harness.clocks,
        // `null` → no setInterval; we drive `tick()` ourselves to keep
        // the test free of timing races.
        pollIntervalMs: null,
      },
    );
    ctx.agent.cron!.start();

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
    const createTool = new CronCreateTool(ctx.agent.cron!);
    const execution = createTool.resolveExecution({
      cron: '*/5 * * * *',
      prompt: 'cron-fired prompt',
      recurring: true,
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
    expect(ctx.agent.cron!.store.list().length).toBe(1);

    // Advance 15 minutes — exactly three ideal */5 fires across the gap
    // (12:05, 12:10, 12:15). See the file header for the calibration
    // derivation.
    harness.advance(15 * 60_000);
    ctx.agent.cron!.tick();

    // ── Steer was called exactly once ─────────────────────────────────
    expect(steerCalls.length).toBe(1);
    const fire = steerCalls[0]!;

    // ── Content carries the user prompt wrapped in the cron-fire envelope ─
    expect(fire.content).toHaveLength(1);
    const fireText = (fire.content[0] as { type: 'text'; text: string }).text;
    expect(fireText).toContain('<cron-fire ');
    expect(fireText).toContain('cron-fired prompt');

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
    const createTool = new CronCreateTool(ctx.agent.cron!);
    const listTool = new CronListTool(ctx.agent.cron!);
    const deleteTool = new CronDeleteTool(ctx.agent.cron!);
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
