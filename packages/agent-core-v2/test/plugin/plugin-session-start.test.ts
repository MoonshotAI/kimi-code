import { afterEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { Emitter } from '#/_base/event';
import {
  IPluginSessionStartInjectorService,
  PluginSessionStartInjectorService,
} from '#/agent/contextInjector/pluginSessionStart';
import { IPluginService } from '#/app/plugin';
import type { EnabledPluginSessionStart, ReloadSummary } from '#/app/plugin/types';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import type { SkillDefinition } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog';

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

describe('PluginSessionStartInjectorService (production wiring)', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    if (ctx !== undefined) await ctx.dispose();
    ctx = undefined;
  });

  it('injects the plugin session-start reminder through the real service during a turn', async () => {
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
        IPluginSessionStartInjectorService,
        new SyncDescriptor(PluginSessionStartInjectorService),
      ),
    );

    // Force-instantiate the real injector (production does this from createMain).
    ctx.get(IPluginSessionStartInjectorService);

    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    const injected = findPluginSessionStartMessages(ctx).at(-1);
    expect(injected).toBeDefined();
    const text = injected === undefined ? '' : messageText(injected);
    expect(text).toContain('<plugin_session_start plugin="demo" skill="demo-skill">');
    expect(text).toContain('Do the demo thing.');
    expect(text).toContain('Always be helpful.');
  });

  it('does not inject when no plugin session starts are enabled', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(IPluginService, pluginServiceStub({ sessionStarts: [] })),
      skillServices(catalog),
      agentService(
        IPluginSessionStartInjectorService,
        new SyncDescriptor(PluginSessionStartInjectorService),
      ),
    );

    ctx.get(IPluginSessionStartInjectorService);

    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

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
        IPluginSessionStartInjectorService,
        new SyncDescriptor(PluginSessionStartInjectorService),
      ),
    );

    ctx.get(IPluginSessionStartInjectorService);

    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);

    // Simulate the skill-catalog sink firing onDidChange (e.g. after a plugin
    // reload re-pulls the plugin source). appendReminderOnReload is async
    // (awaits skillCatalog.ready); let it settle.
    sinkChange.fire();
    await Promise.resolve();
    await Promise.resolve();

    const messages = findPluginSessionStartMessages(ctx);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const latest = messageText(messages.at(-1)!);
    expect(latest).toContain('<plugin_session_start plugin="demo" skill="demo-skill">');
    expect(latest).toContain('supersedes any earlier plugin_session_start reminder');
    sinkChange.dispose();
  });
});
