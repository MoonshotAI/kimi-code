/**
 * Agent + cron wiring smoke: verifies `new Agent(...)` constructs and
 * starts a CronManager, registers the three cron tools, and that
 * `KIMI_DISABLE_CRON=1` short-circuits `CronCreate`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CronCreateTool,
  type CronCreateInput,
} from '../../../src/tools/cron/cron-create';
import { testAgent, type AgentTestContext } from '../harness/agent';

describe('Agent + Cron integration (P1.7)', () => {
  let ctx: AgentTestContext;

  beforeEach(() => {
    ctx = testAgent();
    // `configure({ tools: [...] })` triggers `agent.config.update(...)`,
    // which is the only path that calls `initializeBuiltinTools()`.
    // Listing all three cron tools turns them on in `enabledTools` so
    // `agent.tools.data()[i].active` is true — useful for callers that
    // want to confirm the model would actually see the tool, not just
    // that we registered it.
    ctx.configure({ tools: ['CronCreate', 'CronList', 'CronDelete'] });
  });

  afterEach(async () => {
    await ctx.agent.cron?.stop();
    vi.unstubAllEnvs();
  });

  it('exposes agent.cron with its session store on construction', () => {
    expect(ctx.agent.cron).toBeDefined();
    expect(ctx.agent.cron!.store).toBeDefined();
    expect(ctx.agent.cron!.store.list()).toEqual([]);
  });

  it('registers CronCreate / CronList / CronDelete in the tool manager', () => {
    const toolNames = ctx.agent.tools.data().map((info) => info.name);
    expect(toolNames).toContain('CronCreate');
    expect(toolNames).toContain('CronList');
    expect(toolNames).toContain('CronDelete');

    // All three came in through the builtin barrel.
    for (const name of ['CronCreate', 'CronList', 'CronDelete'] as const) {
      const info = ctx.agent.tools.data().find((i) => i.name === name);
      expect(info?.source).toBe('builtin');
      expect(info?.active).toBe(true);
    }
  });

  it('KIMI_DISABLE_CRON=1 short-circuits CronCreate with a disabled error', () => {
    vi.stubEnv('KIMI_DISABLE_CRON', '1');

    // We construct a fresh CronCreateTool against the agent's cron
    // manager rather than driving a full tool-dispatch loop — the
    // killswitch lives in `resolveExecution`, so a direct call is the
    // precise unit being asserted, and it stays robust if the loop /
    // dispatch surface changes around it (P1.8 onwards).
    const tool = new CronCreateTool(ctx.agent.cron!);
    const args: CronCreateInput = {
      cron: '*/5 * * * *',
      prompt: 'x',
      recurring: true,
    };
    const result = tool.resolveExecution(args);

    // resolveExecution returns a `ToolExecution` — when it errors
    // up-front the shape is `{ isError: true, output: string }` with no
    // `execute` callback (see CronCreate's killswitch branch).
    expect(result).toMatchObject({ isError: true });
    expect('output' in result ? result.output : '').toMatch(/disabled/i);
    expect('execute' in result ? typeof result.execute : 'no-execute').toBe(
      'no-execute',
    );

    // And no task slipped into the store.
    expect(ctx.agent.cron!.store.list()).toEqual([]);
  });
});
