/**
 * Scenario: main-agent plugin session-start reminder wiring.
 *
 * Exercises initial injection and source-specific refresh behavior through the
 * real `AgentPluginService`, with plugin and session catalog boundaries stubbed.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/plugin/agentPlugin.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { Emitter } from '#/_base/event';
import { IAgentPluginService } from '#/agent/plugin/agentPlugin';
import { AgentPluginService } from '#/agent/plugin/agentPluginService';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IEventBus } from '#/app/event/eventBus';
import { IPluginService } from '#/app/plugin/plugin';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import { summarizeSkill } from '#/app/skillCatalog/types';
import type { SkillDefinition } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';

import { agentService, appService, createTestAgent, skillServices, type TestAgentContext } from '../../harness';
import { stubPluginService } from '../../app/plugin/stubs';

function pluginSkill(): SkillDefinition {
  return {
    name: 'demo-skill',
    description: 'A plugin skill',
    path: '/plugins/demo/skills/demo-skill/SKILL.md',
    dir: '/plugins/demo/skills/demo-skill',
    content: 'Do the demo thing.',
    metadata: {},
    source: 'extra',
    plugin: { id: 'demo', instructions: 'Always be helpful.' },
  };
}

function findPluginSessionStartMessages(ctx: TestAgentContext) {
  return ctx.contextData().history.filter(
    (message) =>
      message.origin?.kind === 'injection' && message.origin.variant === 'plugin_session_start',
  );
}

function messageText(message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
  return message.content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('');
}

async function runInjectionBoundary(ctx: TestAgentContext): Promise<void> {
  await ctx.get(IAgentLoopService).hooks.onWillBeginStep.run({
    turnId: 0,
    step: 1,
    signal: new AbortController().signal,
  });
}

describe('AgentPluginService plugin session-start wiring', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    if (ctx !== undefined) await ctx.dispose();
    ctx = undefined;
  });

  it('injects the plugin session-start reminder through the real service registration', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(
        IPluginService,
        stubPluginService({ sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }] }),
      ),
      skillServices(catalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );

    ctx.get(IAgentPluginService);

    await runInjectionBoundary(ctx);

    const injected = findPluginSessionStartMessages(ctx).at(-1);
    expect(injected).toBeDefined();
    const text = injected === undefined ? '' : messageText(injected);
    expect(text).toContain('<plugin_session_start plugin="demo" skill="demo-skill">');
    expect(text).toContain('Do the demo thing.');
    expect(text).toContain('Always be helpful.');
  });

  it('does not re-inject the plugin session-start reminder on later turns while it remains live', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(
        IPluginService,
        stubPluginService({ sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }] }),
      ),
      skillServices(catalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );

    ctx.get(IAgentPluginService);

    await runInjectionBoundary(ctx);
    ctx.get(IEventBus).publish({
      type: 'turn.started',
      turnId: 2,
      origin: USER_PROMPT_ORIGIN,
    });
    await runInjectionBoundary(ctx);

    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);
  });

  it('does not inject when no plugin session starts are enabled', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(IPluginService, stubPluginService({ sessionStarts: [] })),
      skillServices(catalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );

    ctx.get(IAgentPluginService);

    await runInjectionBoundary(ctx);

    expect(findPluginSessionStartMessages(ctx)).toHaveLength(0);
  });

  it('re-appends a fresh reminder when the plugin skill source finishes refreshing', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());
    const sinkChange = new Emitter<string>();
    const skillCatalog: ISessionSkillCatalog = {
      _serviceBrand: undefined,
      catalog,
      ready: Promise.resolve(),
      onDidChange: sinkChange.event,
      load: async () => {},
      reload: async () => {},
      list: async () => catalog.listSkills().map(summarizeSkill),
    };

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(
        IPluginService,
        stubPluginService({
          sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }],
        }),
      ),
      skillServices(skillCatalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );

    ctx.get(IAgentPluginService);

    await runInjectionBoundary(ctx);

    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);

    sinkChange.fire('plugin');
    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);
    await runInjectionBoundary(ctx);

    const messages = findPluginSessionStartMessages(ctx);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const latest = messageText(messages.at(-1)!);
    expect(latest).toContain('<plugin_session_start plugin="demo" skill="demo-skill">');
    expect(latest).toContain('supersedes any earlier plugin_session_start reminder');
    sinkChange.dispose();
  });

  it('appends only for the plugin source when unrelated and plugin changes arrive together', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());
    const sinkChange = new Emitter<string>();
    const skillCatalog: ISessionSkillCatalog = {
      _serviceBrand: undefined,
      catalog,
      ready: Promise.resolve(),
      onDidChange: sinkChange.event,
      load: async () => {},
      reload: async () => {},
      list: async () => catalog.listSkills().map(summarizeSkill),
    };

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(
        IPluginService,
        stubPluginService({
          sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }],
        }),
      ),
      skillServices(skillCatalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );

    ctx.get(IAgentPluginService);

    await runInjectionBoundary(ctx);
    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);

    sinkChange.fire('user');
    sinkChange.fire('plugin');
    await runInjectionBoundary(ctx);

    expect(findPluginSessionStartMessages(ctx)).toHaveLength(2);
    sinkChange.dispose();
  });

  it('reconciles the current plugin guidance after undo removes its latest render', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());
    const sinkChange = new Emitter<string>();
    const skillCatalog: ISessionSkillCatalog = {
      _serviceBrand: undefined,
      catalog,
      ready: Promise.resolve(),
      onDidChange: sinkChange.event,
      load: async () => {},
      reload: async () => {},
      list: async () => catalog.listSkills().map(summarizeSkill),
    };

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(
        IPluginService,
        stubPluginService({
          sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }],
        }),
      ),
      skillServices(skillCatalog),
      agentService(IAgentPluginService, new SyncDescriptor(AgentPluginService)),
    );
    ctx.get(IAgentPluginService);

    ctx.mockNextResponse({ type: 'text', text: 'first answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
    await ctx.untilTurnEnd();

    catalog.register(
      { ...pluginSkill(), content: 'Do the updated demo thing.' },
      { replace: true },
    );
    sinkChange.fire('plugin');
    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
    await ctx.untilTurnEnd();

    await ctx.undoHistory(1);
    ctx.mockNextResponse({ type: 'text', text: 'third answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'third prompt' }] });
    await ctx.untilTurnEnd();

    const latest = findPluginSessionStartMessages(ctx).at(-1);
    expect(latest).toBeDefined();
    expect(messageText(latest!)).toContain('Do the updated demo thing.');
    expect(messageText(latest!)).toContain(
      'supersedes any earlier plugin_session_start reminder',
    );
    sinkChange.dispose();
  });
});
