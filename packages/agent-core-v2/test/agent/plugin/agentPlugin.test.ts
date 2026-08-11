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
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { IEventBus } from '#/app/event/eventBus';
import { IPluginService } from '#/app/plugin/plugin';
import type {
  EnabledPluginSessionStart,
  PluginMutationSummary,
  ReloadSummary,
} from '#/app/plugin/types';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import { summarizeSkill } from '#/app/skillCatalog/types';
import type { SkillDefinition } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';

import { agentService, appService, createTestAgent, skillServices, type TestAgentContext } from '../../harness';

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
  readonly mutateEmitter?: Emitter<PluginMutationSummary>;
}

function pluginServiceStub(options: PluginServiceStubOptions): IPluginService {
  const reloadEmitter = options.reloadEmitter;
  const mutateEmitter = options.mutateEmitter;
  return {
    _serviceBrand: undefined,
    onDidReload: reloadEmitter !== undefined ? reloadEmitter.event : () => ({ dispose: () => {} }),
    onDidMutate: mutateEmitter !== undefined ? mutateEmitter.event : () => ({ dispose: () => {} }),
    listPlugins: async () => [],
    installPlugin: async () => ({ id: '' }) as never,
    setPluginEnabled: async () => {},
    setPluginMcpServerEnabled: async () => {},
    removePlugin: async () => {},
    reloadPlugins: async (): Promise<ReloadSummary> => ({ added: [], removed: [], errors: [] }),
    getPluginInfo: async () => {
      throw new Error('getPluginInfo is not used by these tests');
    },
    listPluginCommands: async () => [],
    checkUpdates: async () => [],
    pluginSkillRoots: async () => [],
    pluginAgentRoots: async () => [],
    enabledSessionStarts: async () => options.sessionStarts,
    enabledSystemPrompts: async () => [],
    enabledMcpServers: async () => ({}),
    enabledHooks: async () => [],
    hasLoadedSnapshot: () => true,
  };
}

function findPluginSessionStartMessages(ctx: TestAgentContext) {
  return ctx.contextData().history.filter(
    (message) =>
      message.origin?.kind === 'injection' && message.origin.variant === 'plugin_session_start',
  );
}

function waitForPluginSessionStartMessage(ctx: TestAgentContext): Promise<void> {
  return new Promise((resolve) => {
    const subscription = ctx.get(IEventBus).subscribe('context.spliced', (event) => {
      if (
        event.messages.some(
          (message) =>
            message.origin?.kind === 'injection' &&
            message.origin.variant === 'plugin_session_start',
        )
      ) {
        subscription.dispose();
        resolve();
      }
    });
  });
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

    const appended = waitForPluginSessionStartMessage(ctx);
    sinkChange.fire('plugin');
    await appended;

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

    const appended = waitForPluginSessionStartMessage(ctx);
    sinkChange.fire('user');
    sinkChange.fire('plugin');
    await appended;

    expect(findPluginSessionStartMessages(ctx)).toHaveLength(2);
    sinkChange.dispose();
  });
});

describe('AgentPluginService plugin-change reminder', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    if (ctx !== undefined) await ctx.dispose();
    ctx = undefined;
  });

  function findPluginChangeMessages(context: TestAgentContext) {
    return context.contextData().history.filter(
      (message) =>
        message.origin?.kind === 'injection' && message.origin.variant === 'plugin_change',
    );
  }

  it('appends a plugin_change system reminder when the plugin set mutates', async () => {
    const mutateEmitter = new Emitter<PluginMutationSummary>();
    ctx = createTestAgent(
      { autoConfigure: true },
      appService(IPluginService, pluginServiceStub({ sessionStarts: [], mutateEmitter })),
      skillServices(new InMemorySkillCatalog()),
      agentService(IAgentPluginService, new SyncDescriptor(AgentPluginService)),
    );
    ctx.get(IAgentPluginService);

    mutateEmitter.fire({
      added: [],
      removed: [],
      errors: [],
      mutation: { kind: 'enable', id: 'demo' },
    });

    const messages = findPluginChangeMessages(ctx);
    expect(messages).toHaveLength(1);
    expect(messageText(messages[0]!)).toContain('Plugin "demo" was enabled.');
    expect(messageText(messages[0]!)).toContain('run /new or /reload to apply the change');
    mutateEmitter.dispose();
  });

  it('does not append the plugin_change reminder on an explicit reload', async () => {
    const reloadEmitter = new Emitter<ReloadSummary>();
    ctx = createTestAgent(
      { autoConfigure: true },
      appService(IPluginService, pluginServiceStub({ sessionStarts: [], reloadEmitter })),
      skillServices(new InMemorySkillCatalog()),
      agentService(IAgentPluginService, new SyncDescriptor(AgentPluginService)),
    );
    ctx.get(IAgentPluginService);

    reloadEmitter.fire({ added: [], removed: [], errors: [] });

    expect(findPluginChangeMessages(ctx)).toHaveLength(0);
    reloadEmitter.dispose();
  });

  function skillCatalogWithChange(catalog: InMemorySkillCatalog, change: Emitter<string>) {
    const skillCatalog: ISessionSkillCatalog = {
      _serviceBrand: undefined,
      catalog,
      ready: Promise.resolve(),
      onDidChange: change.event,
      load: async () => {},
      reload: async () => {},
      list: async () => catalog.listSkills().map(summarizeSkill),
    };
    return skillCatalog;
  }

  function fireMutation(mutateEmitter: Emitter<PluginMutationSummary>, id: string): void {
    mutateEmitter.fire({
      added: [],
      removed: [],
      errors: [],
      mutation: { kind: 'install', id },
    });
  }

  it('suppresses the session-start refresh for mutation-driven catalog changes', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());
    const sinkChange = new Emitter<string>();
    const mutateEmitter = new Emitter<PluginMutationSummary>();
    ctx = createTestAgent(
      { autoConfigure: true },
      appService(
        IPluginService,
        pluginServiceStub({
          sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }],
          mutateEmitter,
        }),
      ),
      skillServices(skillCatalogWithChange(catalog, sinkChange)),
      agentService(IAgentPluginService, new SyncDescriptor(AgentPluginService)),
    );
    ctx.get(IAgentPluginService);
    await injectRegistered(ctx);
    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);

    // Production ordering: onDidMutate fires synchronously inside the
    // mutation's onDidReload; the catalog change arrives after the async
    // re-scan.
    fireMutation(mutateEmitter, 'demo');
    sinkChange.fire('plugin');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(findPluginChangeMessages(ctx)).toHaveLength(1);
    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);

    // An explicit reload (no mutation) still refreshes the guidance.
    const appended = waitForPluginSessionStartMessage(ctx);
    sinkChange.fire('plugin');
    await appended;
    expect(findPluginSessionStartMessages(ctx).length).toBeGreaterThanOrEqual(2);

    sinkChange.dispose();
    mutateEmitter.dispose();
  });

  it('suppresses one session-start refresh per mutation when mutations arrive back to back', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());
    const sinkChange = new Emitter<string>();
    const mutateEmitter = new Emitter<PluginMutationSummary>();
    ctx = createTestAgent(
      { autoConfigure: true },
      appService(
        IPluginService,
        pluginServiceStub({
          sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }],
          mutateEmitter,
        }),
      ),
      skillServices(skillCatalogWithChange(catalog, sinkChange)),
      agentService(IAgentPluginService, new SyncDescriptor(AgentPluginService)),
    );
    ctx.get(IAgentPluginService);
    await injectRegistered(ctx);
    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);

    fireMutation(mutateEmitter, 'demo');
    fireMutation(mutateEmitter, 'demo');
    sinkChange.fire('plugin');
    sinkChange.fire('plugin');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(findPluginChangeMessages(ctx)).toHaveLength(2);
    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);

    sinkChange.dispose();
    mutateEmitter.dispose();
  });
});
