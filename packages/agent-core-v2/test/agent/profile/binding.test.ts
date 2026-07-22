import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Event } from '#/_base/event';
import { ConfigTarget, IConfigService } from '#/app/config/config';
import { TOOLS_SECTION } from '#/agent/toolPolicy/configSection';
import { DEFAULT_AGENT_PROFILE_NAME, IAgentProfileCatalogService } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { registerAgentProfile } from '#/app/agentProfileCatalog/contribution';
import type { ToolCall } from '#/kosong/contract/message';
import { IAgentProfileService, type ResolvedAgentProfile } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
import { IAtomicDocumentStore, type IAtomicDocumentStore as AtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { IWireService } from '#/wire/wire';
import type { ExecutableTool, ToolExecution, ToolResult, ToolSource } from '#/tool/toolContract';

import {
  InMemoryWireRecordPersistence,
  appService,
  createTestAgent,
  hostEnvironmentServices,
  sessionService,
  type TestAgentContext,
} from '../../harness';

const MOCK_MODEL = 'mock-model';

function profileServices(ctx: TestAgentContext): {
  profile: IAgentProfileService;
  toolPolicy: IAgentToolPolicyService;
} {
  return {
    profile: ctx.get(IAgentProfileService),
    toolPolicy: ctx.get(IAgentToolPolicyService),
  };
}

function createAtomicDocumentStore(): AtomicDocumentStore {
  const documents = new Map<string, unknown>();
  const documentKey = (scope: string, key: string): string => `${scope}/${key}`;
  return {
    _serviceBrand: undefined,
    get: async <T>(scope: string, key: string) => documents.get(documentKey(scope, key)) as T | undefined,
    set: async <T>(scope: string, key: string, value: T) => {
      documents.set(documentKey(scope, key), structuredClone(value));
    },
    delete: async (scope: string, key: string) => {
      documents.delete(documentKey(scope, key));
    },
    list: async (scope: string, prefix = '') =>
      [...documents.keys()]
        .filter((key) => key.startsWith(`${scope}/${prefix}`))
        .map((key) => key.slice(scope.length + 1)),
    watch: () => Event.None as Event<void>,
    acquire: () => ({ dispose: () => {} }),
  };
}

describe('AgentProfileService.bind', () => {
  let ctx: TestAgentContext;
  let homeDir: string;

  beforeAll(() => {
    registerAgentProfile({
      name: 'delegates-explore',
      subagents: ['explore'],
      systemPrompt: () => 'delegate test',
    });
  });

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-bind-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  function buildContext(): { ctx: TestAgentContext; profile: IAgentProfileService } {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    return { ctx, profile: ctx.get(IAgentProfileService) };
  }

  it('binds a profile + model atomically and becomes runnable', async () => {
    const { ctx: context, profile: svc } = buildContext();

    const catalog = context.get(IAgentProfileCatalogService);
    expect(catalog.get(DEFAULT_AGENT_PROFILE_NAME)).toBeDefined();

    expect(svc.isRunnable()).toBe(false);

    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(svc.data().modelAlias).toBe(MOCK_MODEL);
    expect(svc.isRunnable()).toBe(true);
    expect(svc.getActiveToolNames()?.length).toBeGreaterThan(0);
    expect(svc.getSystemPrompt()).toContain('Kimi Code CLI');
  });

  it('persists the complete binding in one journal record', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent(
      {
        persistence,
        initialConfig: {
          thinking: { enabled: true, effort: 'low' },
        },
      },
      hostEnvironmentServices(homeDir),
    );
    ctx.configure({
      modelCapabilities: {
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 1_000_000,
      },
    });
    const svc = ctx.get(IAgentProfileService);
    await ctx.get(IWireService).flush();
    const start = persistence.records.length;

    await svc.bind({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: MOCK_MODEL,
      thinking: 'low',
      cwd: homeDir,
    });
    await ctx.get(IWireService).flush();

    const records = persistence.records.slice(start).filter((record) => record.type === 'profile.bind');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'profile.bind',
      cwd: homeDir,
      profileName: DEFAULT_AGENT_PROFILE_NAME,
      modelAlias: MOCK_MODEL,
      thinkingEffort: 'on',
      systemPrompt: expect.stringContaining('Kimi Code CLI'),
      activeToolNames: expect.arrayContaining(['Read', 'Write', 'Bash']),
      disallowedTools: [],
    });
  });

  it('restores the subagent allowlist from the binding record without catalog resolution', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence }, hostEnvironmentServices(homeDir));

    await ctx.get(IAgentProfileService).bind({
      profile: 'delegates-explore',
      model: MOCK_MODEL,
    });
    await ctx.get(IWireService).flush();

    expect(persistence.records.find((record) => record.type === 'profile.bind')).toMatchObject({
      profileName: 'delegates-explore',
      subagents: ['explore'],
    });

    await ctx.dispose();
    const emptyCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: () => undefined,
      getDefault: () => ({
        name: DEFAULT_AGENT_PROFILE_NAME,
        tools: undefined,
        systemPrompt: () => '',
      }),
      list: () => [],
      load: async () => {},
      reload: async () => {},
    } as unknown as ISessionAgentProfileCatalog;
    ctx = createTestAgent(
      { persistence },
      hostEnvironmentServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, emptyCatalog),
    );

    await ctx.restorePersisted();

    expect(ctx.get(IAgentProfileService).data()).toMatchObject({
      profileName: 'delegates-explore',
      subagents: ['explore'],
    });
  });

  it('setModel applies the default profile when none is bound yet', async () => {
    const { profile: svc } = buildContext();

    expect(svc.data().profileName).toBeUndefined();

    await svc.setModel(MOCK_MODEL);

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(svc.data().modelAlias).toBe(MOCK_MODEL);
    expect(svc.isRunnable()).toBe(true);
  });

  it('setModel keeps the existing profile when one is already bound', async () => {
    const { profile: svc } = buildContext();

    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    await svc.setModel(MOCK_MODEL);

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });

  it('rejects binding a different profile once bound', async () => {
    const { profile: svc } = buildContext();

    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    await expect(svc.bind({ profile: 'coder', model: MOCK_MODEL })).rejects.toThrow(
      /already bound/,
    );
    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });

  it('rejects an unsupported thinking effort atomically before first bind', async () => {
    ctx = createTestAgent(
      {
        initialConfig: {
          providers: {
            kimi: { type: 'kimi', apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' },
          },
          models: {
            'kimi-code/kimi-for-coding': {
              provider: 'kimi',
              model: 'kimi-for-coding',
              maxContextSize: 1_000_000,
              capabilities: ['thinking'],
              supportEfforts: ['low', 'high'],
            },
          },
        },
      },
      hostEnvironmentServices(homeDir),
    );
    const svc = ctx.get(IAgentProfileService);

    await expect(
      svc.bind({
        profile: DEFAULT_AGENT_PROFILE_NAME,
        model: 'kimi-code/kimi-for-coding',
        thinking: 'ultra',
        strictThinking: true,
      }),
    ).rejects.toThrow(/not supported by model/);

    // The failed bind must leave the agent unbound — a retry can still bind.
    expect(svc.data().profileName).toBeUndefined();
    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'kimi-code/kimi-for-coding' });
    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });

  it('clamps an inherited unsupported thinking effort instead of rejecting the bind', async () => {
    ctx = createTestAgent(
      {
        initialConfig: {
          providers: {
            kimi: { type: 'kimi', apiKey: 'test-key', baseUrl: 'https://api.example.test/v1' },
          },
          models: {
            'kimi-code/kimi-for-coding': {
              provider: 'kimi',
              model: 'kimi-for-coding',
              maxContextSize: 1_000_000,
              capabilities: ['thinking'],
              supportEfforts: ['low', 'high'],
            },
          },
        },
      },
      hostEnvironmentServices(homeDir),
    );
    const svc = ctx.get(IAgentProfileService);

    // Spawn paths pass inherited (possibly drifted) thinking without
    // strictThinking: the bind must succeed and clamp to a supported effort.
    await svc.bind({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: 'kimi-code/kimi-for-coding',
      thinking: 'ultra',
    });

    expect(svc.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(svc.data().thinkingLevel).toBe('high');
  });

  it('keeps the persisted thinking effort on a same-name rebind', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    ctx.configure({
      modelCapabilities: {
        image_in: false,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 1_000_000,
      },
    });
    const svc = ctx.get(IAgentProfileService);
    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL, thinking: 'off' });
    expect(svc.data().thinkingLevel).toBe('off');

    // A same-name rebind without an explicit thinking override must not reset
    // the persisted effort to the configured/model default ('on' here).
    await svc.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(svc.data().thinkingLevel).toBe('off');
  });
});

describe('AgentToolPolicyService tool denylist', () => {
  // Registration is idempotent (replace-by-name) and scoped to this describe's
  // run window — module-scope registration would also pollute the bind
  // describe above at collection time.
  beforeAll(() => {
    registerAgentProfile({
      name: 'deny-builtin',
      disallowedTools: ['Bash'],
      systemPrompt: () => 'deny test',
    });
    registerAgentProfile({
      name: 'deny-over-allow',
      tools: ['Read', 'Bash'],
      disallowedTools: ['Bash'],
      systemPrompt: () => 'deny test',
    });
    registerAgentProfile({
      name: 'deny-mcp',
      disallowedTools: ['mcp__github__*'],
      systemPrompt: () => 'deny test',
    });
  });

  let ctx: TestAgentContext;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-deny-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  async function bindProfile(name: string): Promise<IAgentToolPolicyService> {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    await ctx.get(IAgentProfileService).bind({ profile: name, model: MOCK_MODEL });
    return ctx.get(IAgentToolPolicyService);
  }

  it('blocks a denied builtin tool while others stay active', async () => {
    const svc = await bindProfile('deny-builtin');
    expect(svc.isToolActive('Bash')).toBe(false);
    expect(svc.isToolActive('Read')).toBe(true);
  });

  it('denylist wins over the allowlist', async () => {
    const svc = await bindProfile('deny-over-allow');
    expect(svc.isToolActive('Bash')).toBe(false);
    expect(svc.isToolActive('Read')).toBe(true);
    expect(svc.isToolActive('Write')).toBe(false);
  });

  it('matches denied mcp tools by glob', async () => {
    const svc = await bindProfile('deny-mcp');
    expect(svc.isToolActive('mcp__github__create_pr', 'mcp')).toBe(false);
    expect(svc.isToolActive('mcp__other__ping', 'mcp')).toBe(true);
    expect(svc.isToolActive('Read')).toBe(true);
  });

  it('lists available profiles when binding an unknown profile', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    await expect(
      ctx.get(IAgentProfileService).bind({ profile: 'does-not-exist', model: MOCK_MODEL }),
    ).rejects.toThrow(/Available profiles: .*agent/);
  });

  it('persists the denylist in the bind records', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence }, hostEnvironmentServices(homeDir));

    await ctx.get(IAgentProfileService).bind({ profile: 'deny-builtin', model: MOCK_MODEL });
    await ctx.get(IWireService).flush();

    const record = persistence.records.find((candidate) => candidate.type === 'profile.bind');
    expect(record).toMatchObject({ profileName: 'deny-builtin', disallowedTools: ['Bash'] });
  });

  it('persists an unrestricted tool policy when the profile has no allowlist', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence }, hostEnvironmentServices(homeDir));
    const { profile, toolPolicy } = profileServices(ctx);

    await profile.bind({ profile: 'deny-builtin', model: MOCK_MODEL });
    await ctx.get(IWireService).flush();

    expect(persistence.records.find((record) => record.type === 'profile.bind')).toMatchObject({
      activeToolNames: undefined,
    });
    expect(toolPolicy.isToolActive('Read')).toBe(true);
    expect(toolPolicy.isToolActive('Bash')).toBe(false);
  });

  it('restores the denylist from persisted records on resume without catalog resolution', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence }, hostEnvironmentServices(homeDir));
    await ctx.get(IAgentProfileService).bind({ profile: 'deny-builtin', model: MOCK_MODEL });
    await ctx.get(IWireService).flush();
    await ctx.dispose();

    // Resume by replaying the same records, with a catalog that cannot resolve
    // the bound profile (e.g. its agent file was deleted): the denylist must
    // come from the persisted record, not from a catalog lookup.
    const emptyCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: () => undefined,
      getDefault: () => ({
        name: DEFAULT_AGENT_PROFILE_NAME,
        tools: undefined,
        systemPrompt: () => '',
      }),
      list: () => [],
      load: async () => {},
      reload: async () => {},
    } as unknown as ISessionAgentProfileCatalog;
    ctx = createTestAgent(
      { persistence },
      hostEnvironmentServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, emptyCatalog),
    );
    await ctx.restorePersisted();
    const resumed = profileServices(ctx);

    expect(resumed.profile.data().profileName).toBe('deny-builtin');
    expect(resumed.toolPolicy.isToolActive('Bash')).toBe(false);
    expect(resumed.toolPolicy.isToolActive('Read')).toBe(true);
  });
});

describe('AgentToolPolicyService global [tools] config', () => {
  beforeAll(() => {
    registerAgentProfile({
      name: 'config-intersect',
      tools: ['Read', 'Bash'],
      disallowedTools: ['Bash'],
      systemPrompt: () => 'config intersect test',
    });
  });

  let ctx: TestAgentContext;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-tools-config-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  async function bindWithToolsConfig(
    tools: Record<string, readonly string[]>,
    profile: string = DEFAULT_AGENT_PROFILE_NAME,
  ): Promise<IAgentToolPolicyService> {
    ctx = createTestAgent({ initialConfig: { tools } }, hostEnvironmentServices(homeDir));
    await ctx.get(IAgentProfileService).bind({ profile, model: MOCK_MODEL });
    return ctx.get(IAgentToolPolicyService);
  }

  it('treats a non-empty enabled list as a global allowlist', async () => {
    const svc = await bindWithToolsConfig({ enabled: ['Read'] });
    expect(svc.isToolActive('Read')).toBe(true);
    expect(svc.isToolActive('Bash')).toBe(false);
  });

  it('treats an empty enabled list as unconstrained', async () => {
    const svc = await bindWithToolsConfig({ enabled: [] });
    expect(svc.isToolActive('Read')).toBe(true);
    expect(svc.isToolActive('Bash')).toBe(true);
  });

  it('applies disabled as a global denylist', async () => {
    const svc = await bindWithToolsConfig({ disabled: ['Bash'] });
    expect(svc.isToolActive('Bash')).toBe(false);
    expect(svc.isToolActive('Read')).toBe(true);
  });

  it('matches globally disabled mcp tools by glob', async () => {
    const svc = await bindWithToolsConfig({ disabled: ['mcp__github__*'] });
    expect(svc.isToolActive('mcp__github__create_pr', 'mcp')).toBe(false);
    expect(svc.isToolActive('mcp__other__ping', 'mcp')).toBe(true);
    expect(svc.isToolActive('Read')).toBe(true);
  });

  it('intersects the global config with the profile policy instead of overriding it', async () => {
    const svc = await bindWithToolsConfig({ enabled: ['Read', 'Bash'] }, 'config-intersect');
    // Allowed by both layers.
    expect(svc.isToolActive('Read')).toBe(true);
    // The global allowlist cannot re-enable a tool the profile itself denies.
    expect(svc.isToolActive('Bash')).toBe(false);
    // Absent from the profile allowlist even though the global one admits it.
    expect(svc.isToolActive('Write')).toBe(false);
  });
});

describe('AgentToolPolicyService.setSessionDisabledTools', () => {
  beforeAll(() => {
    registerAgentProfile({
      name: 'session-deny',
      disallowedTools: ['Write'],
      systemPrompt: () => 'session deny test',
    });
  });

  let ctx: TestAgentContext;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-session-deny-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  async function bind(profile: string): Promise<IAgentToolPolicyService> {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    await ctx.get(IAgentProfileService).bind({ profile, model: MOCK_MODEL });
    return ctx.get(IAgentToolPolicyService);
  }

  it('rejects when no profile is bound yet', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    const toolPolicy = ctx.get(IAgentToolPolicyService);

    await expect(toolPolicy.setSessionDisabledTools(['Bash'])).rejects.toThrow(/not bound/);
    expect(toolPolicy.isToolActive('Bash')).toBe(true);
  });

  it('replaces the client-managed denylist on every call', async () => {
    const svc = await bind(DEFAULT_AGENT_PROFILE_NAME);

    await svc.setSessionDisabledTools(['Bash']);
    expect(svc.isToolActive('Bash')).toBe(false);
    expect(svc.isToolActive('Read')).toBe(true);

    await svc.setSessionDisabledTools(['Edit']);
    expect(svc.isToolActive('Bash')).toBe(true);
    expect(svc.isToolActive('Edit')).toBe(false);
  });

  it('keeps the profile own denylist across replacement calls', async () => {
    const svc = await bind('session-deny');

    await svc.setSessionDisabledTools(['Bash']);
    expect(svc.isToolActive('Write')).toBe(false);
    expect(svc.isToolActive('Bash')).toBe(false);

    await svc.setSessionDisabledTools([]);
    expect(svc.isToolActive('Write')).toBe(false);
    expect(svc.isToolActive('Bash')).toBe(true);
  });

  it('persists the session denylist across a resume', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const atomicDocuments = createAtomicDocumentStore();
    const documentServices = appService(IAtomicDocumentStore, atomicDocuments);
    ctx = createTestAgent(
      { persistence },
      documentServices,
      hostEnvironmentServices(homeDir),
    );
    const { profile, toolPolicy } = profileServices(ctx);
    await profile.bind({ profile: 'session-deny', model: MOCK_MODEL });
    await toolPolicy.setSessionDisabledTools(['Bash']);
    await ctx.get(IWireService).flush();
    await ctx.dispose();

    // Resume by replaying the same records, with a catalog that cannot resolve
    // the bound profile: the session denylist must come from the persisted
    // record, not from a catalog lookup.
    const emptyCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: () => undefined,
      getDefault: () => ({
        name: DEFAULT_AGENT_PROFILE_NAME,
        tools: undefined,
        systemPrompt: () => '',
      }),
      list: () => [],
      load: async () => {},
      reload: async () => {},
    } as unknown as ISessionAgentProfileCatalog;
    ctx = createTestAgent(
      { persistence },
      documentServices,
      hostEnvironmentServices(homeDir),
      sessionService(ISessionAgentProfileCatalog, emptyCatalog),
    );
    await ctx.restorePersisted();
    await ctx.get(ISessionToolPolicy).ready;
    const resumed = profileServices(ctx);

    expect(resumed.toolPolicy.isToolActive('Bash')).toBe(false);
    expect(resumed.toolPolicy.isToolActive('Write')).toBe(false);
    expect(resumed.toolPolicy.isToolActive('Read')).toBe(true);

    await resumed.toolPolicy.setSessionDisabledTools(['Edit']);
    expect(resumed.toolPolicy.isToolActive('Bash')).toBe(true);
    expect(resumed.toolPolicy.isToolActive('Edit')).toBe(false);
    expect(resumed.toolPolicy.isToolActive('Write')).toBe(false);
  });

  it('retries persistence after a failed session denylist replacement', async () => {
    const atomicDocuments = createAtomicDocumentStore();
    const persist = atomicDocuments.set.bind(atomicDocuments);
    let attempts = 0;
    atomicDocuments.set = async (...args) => {
      if (args[0].endsWith('/tool-policy')) {
        attempts += 1;
        if (attempts === 1) throw new Error('disk full');
      }
      await persist(...args);
    };
    ctx = createTestAgent(
      appService(IAtomicDocumentStore, atomicDocuments),
      hostEnvironmentServices(homeDir),
    );
    const { profile, toolPolicy } = profileServices(ctx);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    await expect(toolPolicy.setSessionDisabledTools(['Bash'])).rejects.toThrow('disk full');
    expect(toolPolicy.isToolActive('Bash')).toBe(true);
    await toolPolicy.setSessionDisabledTools(['Bash']);

    expect(attempts).toBe(2);
    expect(toolPolicy.isToolActive('Bash')).toBe(false);
  });

  it('removes the skill listing when the session disables Skill', async () => {
    const skillMarker = 'session-policy-skill-marker';
    ctx = createTestAgent(
      hostEnvironmentServices(homeDir),
      sessionService(ISessionSkillCatalog, {
        _serviceBrand: undefined,
        catalog: { getModelSkillListing: () => skillMarker } as never,
        ready: Promise.resolve(),
        onDidChange: Event.None as Event<string>,
        load: async () => {},
        reload: async () => {},
      }),
    );
    const { profile, toolPolicy } = profileServices(ctx);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.getSystemPrompt()).toContain(skillMarker);

    await toolPolicy.setSessionDisabledTools(['Skill']);

    expect(toolPolicy.isToolActive('Skill')).toBe(false);
    expect(profile.getSystemPrompt()).not.toContain(skillMarker);
  });

  it('omits the skill listing when global tools disable Skill', async () => {
    const skillMarker = 'global-policy-skill-marker';
    ctx = createTestAgent(
      { initialConfig: { tools: { disabled: ['Skill'] } } },
      hostEnvironmentServices(homeDir),
      sessionService(ISessionSkillCatalog, {
        _serviceBrand: undefined,
        catalog: { getModelSkillListing: () => skillMarker } as never,
        ready: Promise.resolve(),
        onDidChange: Event.None as Event<string>,
        load: async () => {},
        reload: async () => {},
      }),
    );
    const { profile, toolPolicy } = profileServices(ctx);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(toolPolicy.isToolActive('Skill')).toBe(false);
    expect(profile.getSystemPrompt()).not.toContain(skillMarker);
  });

  it('refreshes the skill listing when global tool policy changes at runtime', async () => {
    const skillMarker = 'live-global-policy-skill-marker';
    ctx = createTestAgent(
      hostEnvironmentServices(homeDir),
      sessionService(ISessionSkillCatalog, {
        _serviceBrand: undefined,
        catalog: { getModelSkillListing: () => skillMarker } as never,
        ready: Promise.resolve(),
        onDidChange: Event.None as Event<string>,
        load: async () => {},
        reload: async () => {},
      }),
    );
    const { profile, toolPolicy } = profileServices(ctx);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.getSystemPrompt()).toContain(skillMarker);

    await ctx
      .get(IConfigService)
      .replace(TOOLS_SECTION, { disabled: ['Skill'] }, ConfigTarget.Memory);

    expect(toolPolicy.isToolActive('Skill')).toBe(false);
    await vi.waitFor(() => expect(profile.getSystemPrompt()).not.toContain(skillMarker));
  });
});

describe('AgentToolPolicyService executor enforcement', () => {
  let ctx: TestAgentContext;
  let homeDir: string;

  beforeAll(() => {
    registerAgentProfile({
      name: 'executor-deny-builtin',
      disallowedTools: ['PolicyProbe'],
      systemPrompt: () => 'executor policy test',
    });
    registerAgentProfile({
      name: 'executor-deny-mcp',
      disallowedTools: ['mcp__blocked__*'],
      systemPrompt: () => 'executor policy test',
    });
  });

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-executor-policy-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  it.each([
    {
      name: 'profile denylist',
      options: {},
      profile: 'executor-deny-builtin',
      disable: undefined,
    },
    {
      name: 'global tools config',
      options: { initialConfig: { tools: { disabled: ['PolicyProbe'] } } },
      profile: DEFAULT_AGENT_PROFILE_NAME,
      disable: undefined,
    },
    {
      name: 'session denylist',
      options: {},
      profile: DEFAULT_AGENT_PROFILE_NAME,
      disable: ['PolicyProbe'],
    },
  ])('blocks a direct builtin call through $name', async ({ options, profile, disable }) => {
    ctx = createTestAgent(options, hostEnvironmentServices(homeDir));
    const profileService = ctx.get(IAgentProfileService);
    await profileService.bind({ profile, model: MOCK_MODEL });
    if (disable !== undefined) {
      await ctx.get(IAgentToolPolicyService).setSessionDisabledTools(disable);
    }
    const probe = new PolicyProbeTool('PolicyProbe');
    ctx.get(IAgentToolRegistryService).register(probe);

    const result = await executeDirectToolCall(ctx, 'PolicyProbe');

    expect(result).toMatchObject({
      isError: true,
      output: 'Tool "PolicyProbe" is disabled by the active tool policy',
    });
    expect(probe.calls).toBe(0);
  });

  it('blocks a direct MCP call by glob before execution', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    await ctx.get(IAgentProfileService).bind({ profile: 'executor-deny-mcp', model: MOCK_MODEL });
    const probe = new PolicyProbeTool('mcp__blocked__write');
    ctx.get(IAgentToolRegistryService).register(probe, { source: 'mcp' });

    const result = await executeDirectToolCall(ctx, probe.name);

    expect(result).toMatchObject({
      isError: true,
      output: `Tool "${probe.name}" is disabled by the active tool policy`,
    });
    expect(probe.calls).toBe(0);
  });

  it('does not reject select_tools, the policy-gated disclosure loading entry', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    // The default profile's allowlist does not name select_tools; the guard
    // must still let the disclosure entry point through (its loadable set is
    // policy-filtered downstream).
    await ctx.get(IAgentProfileService).bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const probe = new PolicyProbeTool(SELECT_TOOLS_TOOL_NAME);
    ctx.get(IAgentToolRegistryService).register(probe);

    const result = await executeDirectToolCall(ctx, SELECT_TOOLS_TOOL_NAME);

    expect(result).toMatchObject({ output: 'executed' });
    expect(result.isError).toBeFalsy();
    expect(probe.calls).toBe(1);
  });

  it.each([
    {
      name: 'global denylist',
      options: { initialConfig: { tools: { disabled: [SELECT_TOOLS_TOOL_NAME] } } },
      disable: undefined,
    },
    {
      name: 'global allowlist',
      options: { initialConfig: { tools: { enabled: ['Read'] } } },
      disable: undefined,
    },
    {
      name: 'session denylist',
      options: {},
      disable: [SELECT_TOOLS_TOOL_NAME],
    },
  ])('blocks select_tools through an explicit $name', async ({ options, disable }) => {
    ctx = createTestAgent(options, hostEnvironmentServices(homeDir));
    await ctx.get(IAgentProfileService).bind({
      profile: DEFAULT_AGENT_PROFILE_NAME,
      model: MOCK_MODEL,
    });
    if (disable !== undefined) {
      await ctx.get(IAgentToolPolicyService).setSessionDisabledTools(disable);
    }
    const probe = new PolicyProbeTool(SELECT_TOOLS_TOOL_NAME);
    ctx.get(IAgentToolRegistryService).register(probe);

    const result = await executeDirectToolCall(ctx, SELECT_TOOLS_TOOL_NAME);

    expect(result).toMatchObject({
      isError: true,
      output: `Tool "${SELECT_TOOLS_TOOL_NAME}" is disabled by the active tool policy`,
    });
    expect(probe.calls).toBe(0);
  });

});

describe('AgentProfileService tool-pattern warnings', () => {
  let ctx: TestAgentContext;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-tool-pattern-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  function toolPatternWarnings(): readonly { code?: string; message?: string }[] {
    const events = ctx.newEvents() as readonly {
      event: string;
      args?: { code?: string; message?: string };
    }[];
    return events
      .filter((entry) => entry.event === 'warning')
      .map((entry) => entry.args ?? {})
      .filter((args) => args.code === 'tool-pattern-no-match');
  }

  // A file-defined agent, as far as the warning path is concerned: inline so
  // its typo stays out of the builtin-profile known-name vocabulary (a
  // registerAgentProfile contribution would legitimize its own entries).
  const fileProfile: ResolvedAgentProfile = {
    name: 'bad-patterns',
    tools: ['Bashh', 'mcp__github'],
    disallowedTools: ['*'],
    systemPrompt: () => 'tool pattern warning test',
  };

  it('warns about profile entries that can never activate anything', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    await ctx.get(IAgentProfileService).applyProfile(fileProfile);

    const messages = toolPatternWarnings().map((warning) => warning.message ?? '');
    expect(
      messages.some((m) => m.includes('"Bashh"') && m.includes('profile "bad-patterns"')),
    ).toBe(true);
    expect(messages.some((m) => m.includes('"mcp__github"') && m.includes('mcp__github__*'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('"*"') && m.includes('disallowedTools'))).toBe(true);
  });

  it('warns once per pattern across repeated applications of the same profile', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    const svc = ctx.get(IAgentProfileService);
    await svc.applyProfile(fileProfile);
    await svc.applyProfile(fileProfile);

    const messages = toolPatternWarnings().map((warning) => warning.message ?? '');
    expect(messages.filter((m) => m.includes('"Bashh"'))).toHaveLength(1);
  });

  it('warns about global [tools] config entries that can never activate anything', async () => {
    ctx = createTestAgent(
      { initialConfig: { tools: { enabled: ['*'] } } },
      hostEnvironmentServices(homeDir),
    );
    await ctx.get(IAgentProfileService).bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    const messages = toolPatternWarnings().map((warning) => warning.message ?? '');
    expect(
      messages.some(
        (m) =>
          m.includes('"*"') && m.includes('the global [tools] config') && m.includes('enabled'),
      ),
    ).toBe(true);
  });

  it('stays silent for the default profile and an empty [tools] config', async () => {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    await ctx.get(IAgentProfileService).bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });

    expect(toolPatternWarnings()).toEqual([]);
  });

  it('bind also publishes the warnings', async () => {
    registerAgentProfile({
      name: 'bind-bad-patterns',
      tools: ['mcp__github'],
      disallowedTools: ['*'],
      systemPrompt: () => 'bind warning test',
    });
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    await ctx.get(IAgentProfileService).bind({ profile: 'bind-bad-patterns', model: MOCK_MODEL });

    const messages = toolPatternWarnings().map((warning) => warning.message ?? '');
    expect(messages.some((m) => m.includes('"mcp__github"') && m.includes('mcp__github__*'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('"*"') && m.includes('disallowedTools'))).toBe(true);
  });

});

async function executeDirectToolCall(ctx: TestAgentContext, name: string): Promise<ToolResult> {
  const call: ToolCall = {
    type: 'function',
    id: `call_${name}`,
    name,
    arguments: '{}',
  };
  for await (const result of ctx.get(IAgentToolExecutorService).execute([call], {
    signal: new AbortController().signal,
    turnId: 1,
  })) {
    return result.result;
  }
  throw new Error(`No result for tool ${name}`);
}

class PolicyProbeTool implements ExecutableTool<Record<string, never>> {
  readonly description = 'Policy enforcement probe.';
  readonly parameters = { type: 'object', additionalProperties: false };
  calls = 0;

  constructor(
    readonly name: string,
    readonly source?: ToolSource,
  ) {}

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async () => {
        this.calls += 1;
        return { isError: false, output: 'executed' };
      },
    };
  }
}
