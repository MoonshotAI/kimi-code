import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ISessionCronService } from '#/session/cron/sessionCronService';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { createTestAgent, cronServices, type TestAgentContext } from '../../harness';

const CRON_TOOL_NAMES = ['CronCreate', 'CronList', 'CronDelete'] as const;

describe('Agent + Cron — subagent suppression', () => {
  beforeEach(() => {
    vi.stubEnv('KIMI_CRON_MANUAL_TICK', '1');
    vi.stubEnv('KIMI_CRON_NO_JITTER', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("type='sub'", () => {
    let ctx: TestAgentContext;

    beforeEach(() => {
      ctx = createTestAgent(cronServices());
      ctx.announceMain();
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('subagents get no cron tools or SIGUSR1 listener of their own', async () => {
      if (process.platform === 'win32') return;

      const listenerCountBeforeCreate = process.listenerCount('SIGUSR1');
      const agents = ctx.get(IAgentLifecycleService);
      const sub = await agents.create({ agentId: 'sub-cron-test' });

      expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate);
      expect(ctx.get(ISessionCronService).isEnabled).toBe(true);

      const subRegistry = sub.accessor.get(IAgentToolRegistryService);
      for (const name of CRON_TOOL_NAMES) {
        expect(subRegistry.resolve(name)).toBeUndefined();
      }
    });
  });

  describe("type='main'", () => {
    let ctx: TestAgentContext;
    let profile: IAgentProfileService;
    let listenerCountBeforeCreate: number;

    beforeEach(async () => {
      listenerCountBeforeCreate = process.listenerCount('SIGUSR1');
      ctx = createTestAgent();
      ctx.announceMain();
      await ctx.restorePersisted();
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

    beforeEach(async () => {
      listenerCountBeforeCreate = process.listenerCount('SIGUSR1');
      ctx = createTestAgent();
      ctx.announceMain();
      await ctx.restorePersisted();
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
