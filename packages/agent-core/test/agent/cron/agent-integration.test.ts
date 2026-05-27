/**
 * P1.7 — Agent + cron wiring smoke test.
 *
 * The unit-level CronManager behaviour is exhaustively covered by
 * `manager.test.ts` against a hand-rolled Agent stub. This file checks
 * the wiring that stub can't see:
 *
 *   1. `new Agent(...)` constructs a `CronManager` and assigns it to
 *      `agent.cron`, and calls `cron.start()` so the auto-tick loop is
 *      live by the time anyone hands the agent to a tool.
 *
 *   2. `ToolManager.initializeBuiltinTools()` registers `CronCreate`,
 *      `CronList`, and `CronDelete` in the builtin map. We use
 *      `agent.tools.data()` (the public surface used by `getTools` RPC)
 *      to enumerate; that proves both the barrel re-export in
 *      `tools/builtin/index.ts` and the construction-side wiring in
 *      `agent/tool/index.ts` are in place.
 *
 *   3. `KIMI_DISABLE_CRON=1` causes `CronCreateTool.resolveExecution`
 *      to short-circuit with the documented "disabled" error before
 *      doing any work. The killswitch is already enforced inside
 *      CronManager / CronCreateTool; this test pins the contract so a
 *      future refactor can't silently lose it.
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
    await ctx.agent.cron.stop();
    vi.unstubAllEnvs();
  });

  it('exposes agent.cron with its session store on construction', () => {
    expect(ctx.agent.cron).toBeDefined();
    expect(ctx.agent.cron.store).toBeDefined();
    expect(ctx.agent.cron.store.list()).toEqual([]);
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
    const tool = new CronCreateTool(ctx.agent.cron);
    const args: CronCreateInput = {
      cron: '*/5 * * * *',
      prompt: 'x',
      recurring: true,
      durable: false,
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
    expect(ctx.agent.cron.store.list()).toEqual([]);
  });
});
