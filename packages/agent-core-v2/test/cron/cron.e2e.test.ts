/**
 * Session-level cron end-to-end smoke: exercises the full
 * `CronCreateTool → SessionCronService → agent.turn.steer` pipeline
 * through the real `AgentTestContext`, with Date.now controlled by
 * the test so the `coalescedCount = 3` calibration after a 15-minute advance is
 * deterministic regardless of host TZ.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CronCreateTool } from '#/session/cron/tools/cron-create';
import { CronDeleteTool } from '#/session/cron/tools/cron-delete';
import { CronListTool } from '#/session/cron/tools/cron-list';
import type { ExecutableToolOutput } from '#/agent/tool/toolContract';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { createTestAgent, cronServices, type TestAgentContext } from '../harness';

// Local-time anchor (cron-expr matches on local fields, so a UTC anchor
// would shift the result by the host's offset). At noon + 15 min the
// `*\/5 * * * *` ideal fires are 12:05/12:10/12:15 → coalescedCount=3.
const LOCAL_ANCHOR_MS = new Date(2024, 5, 1, 12, 0, 0, 0).getTime();

function createClocks(initial = LOCAL_ANCHOR_MS) {
  let wall = initial;
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
  return {
    advance(ms: number) {
      wall += ms;
    },
  };
}

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
  let ctx: TestAgentContext;
  let cron: ISessionCronService;
  let prompt: IAgentPromptService;
  let harness: ReturnType<typeof createClocks>;

  beforeEach(async () => {
    // Pin jitter off so the recurring fire lands at the ideal 12:05:00
    // mark (not 12:05:00 + up-to-30s) and the 15-minute advance is more
    // than enough to clear it. Note: `coalescedCount` is computed from
    // the unjittered schedule, so jitter has no effect on the count
    // itself — this flag is belt-and-braces against any future refactor
    // that widens the jitter window past 10 minutes.
    vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
    vi.stubEnv('KIMI_CRON_POLL_INTERVAL_MS', '0');
    harness = createClocks();
    ctx = createTestAgent(cronServices());
    cron = ctx.get(ISessionCronService);
    prompt = ctx.get(IAgentPromptService);
    await cron.start();
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });

  it('recurring */5 task advances 15min → exactly one steer with coalescedCount=3', async () => {
    // Spy on the service prompt surface so cron does not launch a real
    // turn without a scripted LLM response.
    const steerCalls: Array<{
      readonly content: readonly unknown[];
      readonly origin: unknown;
    }> = [];
    vi.spyOn(prompt, 'steer').mockImplementation((message: ContextMessage) => {
      steerCalls.push({ content: message.content, origin: message.origin });
      return {
        removeFromQueue: () => {},
        launched: Promise.resolve({
          id: 1,
          signal: new AbortController().signal,
          ready: Promise.resolve(),
          result: Promise.resolve({ type: 'completed' as const, steps: 0, truncated: false }),
        }),
      };
    });

    // Schedule via the full tool surface — the scheduling path goes
    // through validation (parse, 5-year window, cap, byte length) just
    // like the LLM-driven path. A back-door `store.add(...)` would
    // bypass `emitScheduled` telemetry and skip the byte-length /
    // expression checks; that would not be the production code path
    // this commit is meant to smoke.
    const createTool = new CronCreateTool(cron);
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
      turnId: 19,
      toolCallId: 'p19-call',
      signal: new AbortController().signal,
    });
    expect(createResult.isError ?? false).toBe(false);
    expect(cron.list().length).toBe(1);

    // Advance 15 minutes — exactly three ideal */5 fires across the gap
    // (12:05, 12:10, 12:15). See the file header for the calibration
    // derivation.
    harness.advance(15 * 60_000);
    await cron.tick();

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
    // jobId comes back as a ULID (the id shape the store now guarantees).
    const origin = fire.origin as { readonly jobId: string };
    expect(typeof origin.jobId).toBe('string');
    expect(origin.jobId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
  });

  it('CronCreate → CronList → CronDelete cycle returns sensible output', async () => {
    // Optional second case from the P1.9 plan: prove the three-tool
    // surface composes correctly end-to-end on the real manager. No
    // clock manipulation needed — list/delete are time-invariant.
    const createTool = new CronCreateTool(cron);
    const listTool = new CronListTool(cron);
    const deleteTool = new CronDeleteTool(cron);
    const ctxArgs = {
      turnId: 19,
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
    const idMatch = /id:\s*(\S+)/.exec(outputText(createOut.output));
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
