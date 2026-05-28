/**
 * Subagent cron suppression: each session can spawn many subagents, and
 * unconditionally starting a CronManager per agent leaks 1s setInterval
 * timers and SIGUSR1 listeners (under KIMI_CRON_MANUAL_TICK=1) that
 * never serve any purpose — default subagent profiles don't expose the
 * Cron tools to the LLM. This test pins both halves of the fix:
 *
 *   1. `agent.cron` is `null` for `type: 'sub'` so no timers or
 *      listeners leak for ephemeral agents.
 *   2. `cron.start()` is never called for subagents, so the SIGUSR1
 *      listener count stays put.
 *   3. The three Cron tools (`CronCreate` / `CronList` / `CronDelete`)
 *      are NOT registered in the subagent's tool manager.
 *   4. `type: 'main'` and `type: 'independent'` keep the old behaviour
 *      — listener bound, tools registered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testAgent } from '../harness/agent';

const CRON_TOOL_NAMES = ['CronCreate', 'CronList', 'CronDelete'] as const;

describe('Agent + Cron — subagent suppression', () => {
  beforeEach(() => {
    // SIGUSR1 binding only happens under KIMI_CRON_MANUAL_TICK=1
    // (see manager.ts bindSigusr1). Using it as the probe lets us
    // observe `start()` vs no-start without poking private fields.
    vi.stubEnv('KIMI_CRON_MANUAL_TICK', '1');
    vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("type='sub': cron exists, start() is skipped, tools not registered", () => {
    if (process.platform === 'win32') return;

    const before = process.listenerCount('SIGUSR1');
    const ctx = testAgent({ type: 'sub' });

    // Subagents do not get a CronManager instance at all.
    expect(ctx.agent.cron).toBeNull();

    // start() was not called — no SIGUSR1 binding accrued.
    expect(process.listenerCount('SIGUSR1')).toBe(before);

    // Configure with the cron tool names in the whitelist; even with
    // the LLM allowlist explicitly listing them, the BuiltinToolManager
    // must not have constructed the instances for a subagent.
    ctx.configure({ tools: [...CRON_TOOL_NAMES] });
    const toolNames = ctx.agent.tools.data().map((info) => info.name);
    for (const name of CRON_TOOL_NAMES) {
      expect(toolNames).not.toContain(name);
    }
  });

  it("type='main': start() runs, tools registered", () => {
    if (process.platform === 'win32') return;

    const before = process.listenerCount('SIGUSR1');
    const ctx = testAgent({ type: 'main' });

    expect(process.listenerCount('SIGUSR1')).toBe(before + 1);

    ctx.configure({ tools: [...CRON_TOOL_NAMES] });
    const toolNames = ctx.agent.tools.data().map((info) => info.name);
    for (const name of CRON_TOOL_NAMES) {
      expect(toolNames).toContain(name);
    }
  });

  it("type='independent': start() runs, tools registered", () => {
    if (process.platform === 'win32') return;

    const before = process.listenerCount('SIGUSR1');
    const ctx = testAgent({ type: 'independent' });

    expect(process.listenerCount('SIGUSR1')).toBe(before + 1);

    ctx.configure({ tools: [...CRON_TOOL_NAMES] });
    const toolNames = ctx.agent.tools.data().map((info) => info.name);
    for (const name of CRON_TOOL_NAMES) {
      expect(toolNames).toContain(name);
    }
  });
});
