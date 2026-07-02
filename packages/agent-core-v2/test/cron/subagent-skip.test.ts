/**
 * Subagent cron suppression: each session can spawn many subagents, and
 * unconditionally starting an AgentCronService per agent leaks 1s setInterval
 * timers and SIGUSR1 listeners (under KIMI_CRON_MANUAL_TICK=1) that
 * never serve any purpose — default subagent profiles don't expose the
 * Cron tools to the LLM. This test pins both halves of the fix:
 *
 *   1. `agent.cron` is disabled (`isEnabled === false`) for `type: 'sub'`
 *      so no scheduler, timers or listeners leak for ephemeral agents.
 *   2. `cron.start()` is never called for subagents, so the SIGUSR1
 *      listener count stays put.
 *   3. The three Cron tools (`CronCreate` / `CronList` / `CronDelete`)
 *      are NOT registered in the subagent's tool manager.
 *   4. `type: 'main'` and `type: 'independent'` keep the old behaviour
 *      — listener bound, tools registered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentCronService } from '#/agent/cron';
import { IAgentProfileService } from '#/agent/profile';
import { createTestAgent, cronServices, type TestAgentContext } from '../harness';

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

  describe("type='sub'", () => {
    let ctx: TestAgentContext;
    let cron: IAgentCronService;
    let profile: IAgentProfileService;
    let listenerCountBeforeCreate: number;

    beforeEach(() => {
      listenerCountBeforeCreate = process.listenerCount('SIGUSR1');
      ctx = createTestAgent(cronServices({ _serviceBrand: undefined, agentId: 'sub-1' }));
      cron = ctx.get(IAgentCronService);
      profile = ctx.get(IAgentProfileService);
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('cron exists, start() is skipped, tools not registered', () => {
      if (process.platform === 'win32') return;

      // Subagents get a disabled AgentCronService: no scheduler, no timers,
      // no SIGUSR1 listener and no tools — the service-DI equivalent of
      // the old `agent.cron === null`.
      expect(cron.isEnabled).toBe(false);

      // start() was not called — no SIGUSR1 binding accrued.
      expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate);

      // Configure with the cron tool names in the whitelist; even with
      // the LLM allowlist explicitly listing them, the BuiltinToolManager
      // must not have constructed the instances for a subagent.
      profile.update({ activeToolNames: [...CRON_TOOL_NAMES] });
      const toolNames = ctx.toolsData().map((info) => info.name);
      for (const name of CRON_TOOL_NAMES) {
        expect(toolNames).not.toContain(name);
      }
    });
  });

  describe("type='main'", () => {
    let ctx: TestAgentContext;
    let profile: IAgentProfileService;
    let listenerCountBeforeCreate: number;

    beforeEach(() => {
      listenerCountBeforeCreate = process.listenerCount('SIGUSR1');
      ctx = createTestAgent();
      profile = ctx.get(IAgentProfileService);
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('start() runs, tools registered', () => {
      if (process.platform === 'win32') return;

      expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate + 1);

      profile.update({ activeToolNames: [...CRON_TOOL_NAMES] });
      const toolNames = ctx.toolsData().map((info) => info.name);
      for (const name of CRON_TOOL_NAMES) {
        expect(toolNames).toContain(name);
      }
    });
  });

  describe("type='independent'", () => {
    let ctx: TestAgentContext;
    let profile: IAgentProfileService;
    let listenerCountBeforeCreate: number;

    beforeEach(() => {
      listenerCountBeforeCreate = process.listenerCount('SIGUSR1');
      ctx = createTestAgent();
      profile = ctx.get(IAgentProfileService);
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('start() runs, tools registered', () => {
      if (process.platform === 'win32') return;

      expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate + 1);

      profile.update({ activeToolNames: [...CRON_TOOL_NAMES] });
      const toolNames = ctx.toolsData().map((info) => info.name);
      for (const name of CRON_TOOL_NAMES) {
        expect(toolNames).toContain(name);
      }
    });
  });
});
