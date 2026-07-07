import { afterEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { Emitter } from '#/_base/event';
import { IAgentPluginService } from '#/agent/plugin/agentPlugin';
import { AgentPluginService } from '#/agent/plugin/agentPluginService';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { IEventBus } from '#/app/event/eventBus';
import { IPluginService } from '#/app/plugin/plugin';
import type { EnabledPluginSessionStart, ReloadSummary } from '#/app/plugin/types';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import type { SkillDefinition } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';

import { agentService, appService, createTestAgent, skillServices, type TestAgentContext } from '../harness';

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

interface PluginServiceStubOptions {
  readonly sessionStarts: readonly EnabledPluginSessionStart[];
  readonly reloadEmitter?: Emitter<ReloadSummary>;
}

function pluginServiceStub(options: PluginServiceStubOptions): IPluginService {
  const reloadEmitter = options.reloadEmitter;
  return {
    _serviceBrand: undefined,
    onDidReload: reloadEmitter !== undefined ? reloadEmitter.event : () => ({ dispose: () => {} }),
    listPlugins: async () => [],
    installPlugin: async () => ({ id: '' }) as never,
    setPluginEnabled: async () => {},
    setPluginMcpServerEnabled: async () => {},
    removePlugin: async () => {},
    reloadPlugins: async (): Promise<ReloadSummary> => ({ added: [], removed: [], errors: [] }),
    getPluginInfo: async () => undefined,
    listPluginCommands: async () => [],
    checkUpdates: async () => [],
    pluginSkillRoots: async () => [],
    enabledSessionStarts: async () => options.sessionStarts,
    enabledMcpServers: async () => ({}),
    enabledHooks: async () => [],
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

async function injectRegistered(ctx: TestAgentContext): Promise<void> {
  await (ctx.get(IAgentContextInjectorService) as unknown as { inject(): Promise<void> }).inject();
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
        pluginServiceStub({ sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }] }),
      ),
      skillServices(catalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );

    // Force-instantiate the real service (production does this from createMain).
    ctx.get(IAgentPluginService);

    await injectRegistered(ctx);

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
        pluginServiceStub({ sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }] }),
      ),
      skillServices(catalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );

    ctx.get(IAgentPluginService);

    await injectRegistered(ctx);
    ctx.get(IEventBus).publish({
      type: 'turn.started',
      turnId: 2,
      origin: USER_PROMPT_ORIGIN,
    });
    await injectRegistered(ctx);

    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);
  });

  it('does not inject when no plugin session starts are enabled', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(IPluginService, pluginServiceStub({ sessionStarts: [] })),
      skillServices(catalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );

    ctx.get(IAgentPluginService);

    await injectRegistered(ctx);

    expect(findPluginSessionStartMessages(ctx)).toHaveLength(0);
  });

  it('re-appends a fresh reminder when the skill catalog sink changes', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());
    const sinkChange = new Emitter<void>();
    const skillCatalog: ISessionSkillCatalog = {
      _serviceBrand: undefined,
      catalog,
      ready: Promise.resolve(),
      onDidChange: sinkChange.event,
      load: async () => {},
      reload: async () => {},
    };

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(
        IPluginService,
        pluginServiceStub({
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

    await injectRegistered(ctx);

    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);

    // Simulate the skill-catalog sink firing onDidChange (e.g. after a plugin
    // reload re-pulls the plugin source). appendFreshSessionStartReminder is async
    // (awaits skillCatalog.ready); let it settle.
    sinkChange.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const messages = findPluginSessionStartMessages(ctx);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const latest = messageText(messages.at(-1)!);
    expect(latest).toContain('<plugin_session_start plugin="demo" skill="demo-skill">');
    expect(latest).toContain('supersedes any earlier plugin_session_start reminder');
    sinkChange.dispose();
  });
});
