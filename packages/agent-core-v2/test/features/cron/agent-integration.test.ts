import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentCron, type CronRuntime } from '#/features/cron/cronAgentRuntime';
import type { CronConfig } from '#/features/cron/configSection';
import type { CronCreateInput } from '#/features/cron/tools/cron-create/cron-create';
import type { CronCreateTool } from '#/features/cron/tools/cron-create/cronCreateTool';

import { createTestAgent, type TestAgentContext } from '../../harness';

const BASE_CRON_CONFIG: CronConfig = {
  debug: false,
  noJitter: true,
  noStale: false,
  disabled: false,
  manualTick: true,
};

describe('Agent + Cron integration', () => {
  describe('default cron wiring', () => {
    let ctx: TestAgentContext;
    let cron: CronRuntime;

    beforeEach(() => {
      ctx = createTestAgent();
      ctx.kimiConfig = { ...ctx.kimiConfig, cron: BASE_CRON_CONFIG };
      cron = ctx.resolve(AgentCron);
      const profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['CronCreate', 'CronList', 'CronDelete'] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('exposes the cron runtime with an empty task set on construction', () => {
      expect(cron.isEnabled).toBe(true);
      expect(cron.isDisabled()).toBe(false);
      expect(cron.list()).toEqual([]);
    });

    it('registers CronCreate / CronList / CronDelete as active builtin tools', () => {
      const toolNames = ctx.toolsData().map((info) => info.name);
      for (const name of ['CronCreate', 'CronList', 'CronDelete'] as const) {
        expect(toolNames).toContain(name);
        const info = ctx.toolsData().find((i) => i.name === name);
        expect(info?.source).toBe('builtin');
        expect(info?.active).toBe(true);
      }
    });
  });

  describe('disabled cron config', () => {
    let ctx: TestAgentContext;
    let cron: CronRuntime;
    let tools: IAgentToolRegistryService;

    beforeEach(() => {
      ctx = createTestAgent();
      ctx.kimiConfig = { ...ctx.kimiConfig, cron: { ...BASE_CRON_CONFIG, disabled: true } };
      cron = ctx.resolve(AgentCron);
      tools = ctx.get(IAgentToolRegistryService);
      ctx.get(IAgentProfileService).update({ activeToolNames: ['CronCreate'] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('short-circuits CronCreate with a disabled error', async () => {
      const tool = tools.resolve('CronCreate') as CronCreateTool | undefined;
      expect(tool).toBeDefined();
      const args: CronCreateInput = {
        cron: '*/5 * * * *',
        prompt: 'x',
        recurring: true,
      };
      const result = await tool!.resolveExecution(args);

      expect(result).toMatchObject({ isError: true });
      expect('output' in result ? result.output : '').toMatch(/disabled/i);
      expect('execute' in result ? typeof result.execute : 'no-execute').toBe(
        'no-execute',
      );

      expect(cron.list()).toEqual([]);
    });
  });
});
