import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentCron } from '#/features/cron/cronAgentRuntime';
import type { CronConfig } from '#/features/cron/configSection';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { createTestAgent, type TestAgentContext } from '../../harness';

const CRON_TOOL_NAMES = ['CronCreate', 'CronList', 'CronDelete'] as const;
const MAIN_AGENT_ONLY_ERROR = 'Cron tools are only supported by the main agent.';

const CRON_CONFIG: CronConfig = {
  debug: false,
  noJitter: true,
  noStale: false,
  disabled: false,
  manualTick: true,
};

function cronToolInput(name: (typeof CRON_TOOL_NAMES)[number]): unknown {
  if (name === 'CronCreate') {
    return { cron: '*/5 * * * *', prompt: 'ping', recurring: true };
  }
  if (name === 'CronDelete') {
    return { id: '01HF7YAT00TP4QF6RDFFZR3QJ7' };
  }
  return {};
}

describe('Agent + Cron — subagent suppression', () => {
  describe('subagent', () => {
    let ctx: TestAgentContext;
    let listenerCountBeforeCreate: number;

    beforeEach(async () => {
      listenerCountBeforeCreate = process.listenerCount('SIGUSR1');
      ctx = createTestAgent();
      ctx.kimiConfig = { ...ctx.kimiConfig, cron: CRON_CONFIG };
      await ctx.restorePersisted();
    });

    afterEach(async () => {
      await ctx.dispose();
    });

    it('gets no SIGUSR1 listener of its own and cron tools reject main-agent-only', async () => {
      if (process.platform === 'win32') return;

      expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate + 1);

      const agents = ctx.get(IAgentLifecycleService);
      const sub = await agents.create({ agentId: 'sub-cron-test' });

      expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate + 1);
      expect(ctx.resolve(AgentCron).isEnabled).toBe(true);

      const subHandle = agents.handleOf(sub.agentId);
      expect(subHandle).toBeDefined();
      const subRegistry = subHandle!.accessor.get(IAgentToolRegistryService);
      for (const name of CRON_TOOL_NAMES) {
        const tool = subRegistry.resolve(name);
        expect(tool).toBeDefined();
        const execution = await tool!.resolveExecution(cronToolInput(name));
        expect(execution).toMatchObject({ isError: true, output: MAIN_AGENT_ONLY_ERROR });
      }
    });
  });

  describe('main agent', () => {
    let ctx: TestAgentContext;
    let listenerCountBeforeCreate: number;

    beforeEach(async () => {
      listenerCountBeforeCreate = process.listenerCount('SIGUSR1');
      ctx = createTestAgent();
      ctx.kimiConfig = { ...ctx.kimiConfig, cron: CRON_CONFIG };
      await ctx.restorePersisted();
      ctx.get(IAgentProfileService).update({ activeToolNames: [...CRON_TOOL_NAMES] });
    });

    afterEach(async () => {
      try {
        await ctx.expectResumeMatches();
      } finally {
        await ctx.dispose();
      }
    });

    it('binds one SIGUSR1 listener on restore and registers the cron tools', () => {
      if (process.platform === 'win32') return;

      expect(process.listenerCount('SIGUSR1')).toBe(listenerCountBeforeCreate + 1);

      const toolNames = ctx.toolsData().map((info) => info.name);
      for (const name of CRON_TOOL_NAMES) {
        expect(toolNames).toContain(name);
      }
    });
  });
});
