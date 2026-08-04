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
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentConversationUndoService } from '#/agent/undo/undo';
import { IPluginService } from '#/app/plugin/plugin';
import type { EnabledPluginSessionStart, ReloadSummary } from '#/app/plugin/types';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import { summarizeSkill } from '#/app/skillCatalog/types';
import type { SkillDefinition } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { IWireService } from '#/wire/wire';

import {
  agentService,
  appService,
  createTestAgent,
  InMemoryWireRecordPersistence,
  skillServices,
  type TestAgentContext,
} from '../../harness';

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
  readonly sessionStartsReader?: () => Promise<readonly EnabledPluginSessionStart[]>;
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
    getPluginInfo: async () => {
      throw new Error('getPluginInfo is not used by these tests');
    },
    listPluginCommands: async () => [],
    checkUpdates: async () => [],
    pluginSkillRoots: async () => [],
    pluginAgentRoots: async () => [],
    enabledSessionStarts: options.sessionStartsReader ?? (async () => options.sessionStarts),
    enabledSystemPrompts: async () => [],
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

async function runTurn(ctx: TestAgentContext, prompt: string): Promise<void> {
  ctx.mockNextResponse({ type: 'text', text: `response to ${prompt}` });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: prompt }] });
  await ctx.untilTurnEnd();
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

    await runTurn(ctx, 'initial turn');

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

    await runTurn(ctx, 'first turn');
    await runTurn(ctx, 'second turn');

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

    await runTurn(ctx, 'initial turn');

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

    await runTurn(ctx, 'initial turn');

    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);

    const refreshedSkill = pluginSkill();
    catalog.register({ ...refreshedSkill, content: 'Do the refreshed demo thing.' }, { replace: true });

    sinkChange.fire('plugin');
    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);
    await runTurn(ctx, 'turn after refresh');

    const messages = findPluginSessionStartMessages(ctx);
    expect(messages).toHaveLength(2);
    const latest = messageText(messages.at(-1)!);
    expect(latest).toContain('<plugin_session_start plugin="demo" skill="demo-skill">');
    expect(latest).toContain('Do the refreshed demo thing.');
    expect(latest).toContain('supersedes any earlier plugin_session_start reminder');
    sinkChange.dispose();
  });

  it('does not append when a plugin source refresh renders the same reminder', async () => {
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
      list: async () => [],
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

    await runTurn(ctx, 'initial turn');
    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);

    sinkChange.fire('plugin');
    await runTurn(ctx, 'turn after no-op refresh');

    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);
    sinkChange.dispose();
  });

  it('re-renders against the latest catalog revision before a racing step reaches the model', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());
    catalog.register({
      ...pluginSkill(),
      name: 'refreshed-skill',
      path: '/plugins/demo/skills/refreshed-skill/SKILL.md',
      dir: '/plugins/demo/skills/refreshed-skill',
      content: 'Use the latest catalog revision.',
    });
    const sinkChange = new Emitter<string>();
    let sessionStarts: readonly EnabledPluginSessionStart[] = [
      { pluginId: 'demo', skillName: 'demo-skill' },
    ];
    let reads = 0;
    let releaseFirstRead!: () => void;
    let markFirstReadStarted!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve;
    });
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    const skillCatalog: ISessionSkillCatalog = {
      _serviceBrand: undefined,
      catalog,
      ready: Promise.resolve(),
      onDidChange: sinkChange.event,
      load: async () => {},
      reload: async () => {},
      list: async () => [],
    };
    const pluginService = pluginServiceStub({
      sessionStarts,
      sessionStartsReader: async () => {
        reads += 1;
        const result = sessionStarts;
        if (reads === 1) {
          markFirstReadStarted();
          await firstRead;
        }
        return result;
      },
    });

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(IPluginService, pluginService),
      skillServices(skillCatalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );
    ctx.get(IAgentPluginService);
    const initialTurn = runTurn(ctx, 'initial turn');

    await firstReadStarted;
    sessionStarts = [{ pluginId: 'demo', skillName: 'refreshed-skill' }];
    sinkChange.fire('plugin');
    releaseFirstRead();
    await initialTurn;

    const messages = findPluginSessionStartMessages(ctx);
    expect(messages).toHaveLength(1);
    expect(reads).toBe(2);
    expect(messageText(messages[0]!)).toContain('Use the latest catalog revision.');
    expect(ctx.llmCalls[0]!.history.map(messageText).join('\n')).toContain(
      'Use the latest catalog revision.',
    );
    sinkChange.dispose();
  });

  it('neutralizes removed plugin session starts only once', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());
    const sinkChange = new Emitter<string>();
    const sessionStarts: EnabledPluginSessionStart[] = [
      { pluginId: 'demo', skillName: 'demo-skill' },
    ];
    const skillCatalog: ISessionSkillCatalog = {
      _serviceBrand: undefined,
      catalog,
      ready: Promise.resolve(),
      onDidChange: sinkChange.event,
      load: async () => {},
      reload: async () => {},
      list: async () => [],
    };

    ctx = createTestAgent(
      { autoConfigure: true },
      appService(IPluginService, pluginServiceStub({ sessionStarts })),
      skillServices(skillCatalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );

    ctx.get(IAgentPluginService);
    await runTurn(ctx, 'initial turn');
    sessionStarts.length = 0;

    sinkChange.fire('plugin');
    await runTurn(ctx, 'turn after removal');
    sinkChange.fire('plugin');
    await runTurn(ctx, 'turn after repeated removal');

    const messages = findPluginSessionStartMessages(ctx);
    expect(messages).toHaveLength(2);
    expect(messageText(messages.at(-1)!)).toContain(
      'There are currently no active plugin session starts.',
    );
    sinkChange.dispose();
  });

  it('restores the rendered reminder fingerprint across agent resumes', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const catalog = new InMemorySkillCatalog();
    catalog.register(pluginSkill());
    const firstSkillCatalog: ISessionSkillCatalog = {
      _serviceBrand: undefined,
      catalog,
      ready: Promise.resolve(),
      onDidChange: () => ({ dispose: () => {} }),
      load: async () => {},
      reload: async () => {},
      list: async () => [],
    };
    const pluginService = pluginServiceStub({
      sessionStarts: [{ pluginId: 'demo', skillName: 'demo-skill' }],
    });

    ctx = createTestAgent(
      { autoConfigure: true, persistence },
      appService(IPluginService, pluginService),
      skillServices(firstSkillCatalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );
    ctx.get(IAgentPluginService);
    await runTurn(ctx, 'initial turn');
    await ctx.get(IWireService).flush();
    await ctx.dispose();

    const sinkChange = new Emitter<string>();
    const resumedSkillCatalog: ISessionSkillCatalog = {
      ...firstSkillCatalog,
      onDidChange: sinkChange.event,
    };
    ctx = createTestAgent(
      { autoConfigure: false, persistence },
      appService(IPluginService, pluginService),
      skillServices(resumedSkillCatalog),
      agentService(
        IAgentPluginService,
        new SyncDescriptor(AgentPluginService),
      ),
    );
    ctx.get(IAgentPluginService);
    await ctx.restorePersisted();

    sinkChange.fire('plugin');
    await runTurn(ctx, 'turn after resume');

    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);
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

    await runTurn(ctx, 'initial turn');
    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);

    const refreshedSkill = pluginSkill();
    catalog.register({ ...refreshedSkill, content: 'Do the refreshed demo thing.' }, { replace: true });
    sinkChange.fire('user');
    sinkChange.fire('plugin');
    await runTurn(ctx, 'turn after refresh');

    expect(findPluginSessionStartMessages(ctx)).toHaveLength(2);
    sinkChange.dispose();
  });

  it('reconciles the latest plugin reminder before the replacement step after undo', async () => {
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
      list: async () => [],
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

    await runTurn(ctx, 'first turn');

    const refreshedSkill = pluginSkill();
    const refresh = ctx.get(IAgentLoopService).hooks.onWillBeginStep.register(
      'test-plugin-refresh',
      async (_hookCtx, next) => {
        catalog.register(
          { ...refreshedSkill, content: 'Do the refreshed demo thing.' },
          { replace: true },
        );
        sinkChange.fire('plugin');
        refresh.dispose();
        await next();
      },
      { before: 'context-injector' },
    );
    await runTurn(ctx, 'second turn');
    expect(messageText(findPluginSessionStartMessages(ctx).at(-1)!)).toContain(
      'Do the refreshed demo thing.',
    );

    await ctx.get(IAgentConversationUndoService).undo(1);
    expect(findPluginSessionStartMessages(ctx)).toHaveLength(1);

    await runTurn(ctx, 'replacement turn');

    const replacementRequest = ctx.llmCalls.at(-1);
    expect(replacementRequest).toBeDefined();
    const requestText = replacementRequest!.history.map(messageText).join('\n');
    expect(requestText).toContain('Do the refreshed demo thing.');
    expect(messageText(findPluginSessionStartMessages(ctx).at(-1)!)).toContain(
      'Do the refreshed demo thing.',
    );
    sinkChange.dispose();
  });
});
