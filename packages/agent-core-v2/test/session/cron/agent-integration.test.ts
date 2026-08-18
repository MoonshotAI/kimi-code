import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CronCreateInput } from '#/agent/tools/cron/cron-create/cron-create';
import { CronCreateTool } from '#/agent/tools/cron/cron-create/cronCreateTool';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { createTestAgent, type TestAgentContext } from '../../harness';

describe('Agent + Cron integration (P1.7)', () => {
  describe('default cron wiring', () => {
    let ctx: TestAgentContext;
    let cron: ISessionCronService;
    let profile: IAgentProfileService;

    beforeEach(() => {
      ctx = createTestAgent();
      ctx.announceMain();
      cron = ctx.get(ISessionCronService);
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['CronCreate', 'CronList', 'CronDelete'] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
        vi.unstubAllEnvs();
      }
    });

    it('exposes agent.cron with an empty task set on construction', () => {
      expect(cron).toBeDefined();
      expect(cron.isEnabled).toBe(true);
      expect(cron.list()).toEqual([]);
    });

    it('registers CronCreate / CronList / CronDelete in the tool manager', async () => {
      await vi.waitFor(() => {
        expect(ctx.toolsData().map((info) => info.name)).toContain('CronCreate');
      });
      const toolNames = ctx.toolsData().map((info) => info.name);
      expect(toolNames).toContain('CronCreate');
      expect(toolNames).toContain('CronList');
      expect(toolNames).toContain('CronDelete');

      for (const name of ['CronCreate', 'CronList', 'CronDelete'] as const) {
        const info = ctx.toolsData().find((i) => i.name === name);
        expect(info?.source).toBe('builtin');
        expect(info?.active).toBe(true);
      }
    });
  });

  describe('disabled cron config', () => {
    let ctx: TestAgentContext;
    let cron: ISessionCronService;
    let profile: IAgentProfileService;
    let tools: IAgentToolRegistryService;

    beforeEach(() => {
      vi.stubEnv('KIMI_DISABLE_CRON', '1');
      ctx = createTestAgent();
      ctx.announceMain();
      cron = ctx.get(ISessionCronService);
      profile = ctx.get(IAgentProfileService);
      tools = ctx.get(IAgentToolRegistryService);
      profile.update({ activeToolNames: ['CronCreate'] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
        vi.unstubAllEnvs();
      }
    });

    it('short-circuits CronCreate with a disabled error', () => {
      const tool = tools.resolve('CronCreate') as CronCreateTool | undefined;
      expect(tool).toBeDefined();
      const args: CronCreateInput = {
        cron: '*/5 * * * *',
        prompt: 'x',
        recurring: true,
      };
      const result = tool!.resolveExecution(args);

      expect(result).toMatchObject({ isError: true });
      expect('output' in result ? result.output : '').toMatch(/disabled/i);
      expect('execute' in result ? typeof result.execute : 'no-execute').toBe(
        'no-execute',
      );

      expect(cron.list()).toEqual([]);
    });
  });
});
