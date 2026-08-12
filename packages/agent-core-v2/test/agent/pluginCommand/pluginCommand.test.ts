/**
 * Scenario: `IAgentPluginCommandService.activate` drives a user-slash plugin
 * command into the prompt pipeline.
 *
 * Pins the activation flow: definition lookup (unknown commands reject with
 * `request.invalid`), argument expansion, the `plugin_command.activated`
 * domain event, the enqueued user message, and the main-agent prompt-metadata
 * update. Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/pluginCommand/pluginCommand.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { IEventBus } from '#/app/event/eventBus';
import { IPluginService } from '#/app/plugin/plugin';
import type { PluginCommandDef } from '#/app/plugin/types';
import { ErrorCodes } from '#/errors';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import {
  IAgentPluginCommandService,
  type PluginCommandActivatedEvent,
} from '#/agent/pluginCommand/pluginCommand';

import { appService, createTestAgent, type TestAgentContext } from '../../harness';

const DEPLOY_COMMAND: PluginCommandDef = {
  pluginId: 'demo',
  name: 'deploy',
  description: 'Deploy',
  body: 'Deploy body',
  path: '/plugins/demo/deploy.md',
};

function pluginServiceStub(commands: readonly PluginCommandDef[]): IPluginService {
  return {
    _serviceBrand: undefined,
    onDidReload: () => ({ dispose: () => {} }),
    onDidMutate: () => ({ dispose: () => {} }),
    listPlugins: async () => [],
    installPlugin: async () => ({ id: '' }) as never,
    setPluginEnabled: async () => {},
    setPluginMcpServerEnabled: async () => {},
    removePlugin: async () => {},
    reloadPlugins: async () => ({ added: [], removed: [], errors: [] }),
    getPluginInfo: async () => {
      throw new Error('getPluginInfo is not used by these tests');
    },
    listPluginCommands: async () => commands,
    checkUpdates: async () => [],
    pluginSkillRoots: async () => [],
    pluginAgentRoots: async () => [],
    enabledSessionStarts: async () => [],
    enabledSystemPrompts: async () => [],
    enabledMcpServers: async () => ({}),
    enabledHooks: async () => [],
    hasLoadedSnapshot: () => true,
  };
}

describe('AgentPluginCommandService', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  function agentWithDeployCommand(): TestAgentContext {
    return createTestAgent(
      appService(IPluginService, pluginServiceStub([DEPLOY_COMMAND])),
    );
  }

  it('publishes the activation event, enqueues the expanded body, and updates metadata', async () => {
    ctx = agentWithDeployCommand();
    ctx.mockNextResponse({ type: 'text', text: 'deployed' });

    const events: PluginCommandActivatedEvent[] = [];
    const sub = ctx
      .get(IEventBus)
      .subscribe('plugin_command.activated', (event) => events.push(event));

    await ctx
      .get(IAgentPluginCommandService)
      .activate({ pluginId: 'demo', commandName: 'deploy', args: 'prod' });
    sub.dispose();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'plugin_command.activated',
      pluginId: 'demo',
      commandName: 'deploy',
      commandArgs: 'prod',
      trigger: 'user-slash',
    });

    await ctx.untilTurnEnd();
    const llmInput = JSON.stringify(ctx.llmInputs());
    expect(llmInput).toContain('Deploy body');
    expect(llmInput).toContain('ARGUMENTS: prod');

    const metadata = await ctx.get(ISessionMetadata).read();
    expect(metadata.title).toBe('/demo:deploy prod');
    expect(metadata.lastPrompt).toBe('/demo:deploy prod');
  });

  it('rejects an unknown command with request.invalid', async () => {
    ctx = agentWithDeployCommand();

    await expect(
      ctx
        .get(IAgentPluginCommandService)
        .activate({ pluginId: 'demo', commandName: 'missing' }),
    ).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
  });
});
