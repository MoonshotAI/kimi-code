import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IAgentProfileService, type ResolvedAgentProfile } from '#/agent/profile/profile';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IPluginService } from '#/app/plugin/plugin';
import type { EnabledPluginSystemPrompt } from '#/app/plugin/types';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import type { SkillCatalog } from '#/app/skillCatalog/types';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import {
  BUILTIN_SKILL_SOURCE_ID,
  PLUGIN_SKILL_SOURCE_ID,
} from '#/app/skillCatalog/skillSource';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { DEFAULT_PRODUCT_NAME } from '#/app/agentProfileCatalog/profile-shared';

import { stubAgentIdentity } from '../../app/agentIdentity/stubs';

import {
  appService,
  createTestAgent,
  execEnvServices,
  hostEnvironmentServices,
  sessionService,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../../harness';

const profile: ResolvedAgentProfile = normalizeAgentProfile({
  name: 'agents-profile',
  systemPrompt: (context) =>
    typeof context['agentsMd'] === 'string' ? (context['agentsMd'] as string) : '',
  tools: [],
});

const pluginProfile: ResolvedAgentProfile = normalizeAgentProfile({
  name: 'plugin-profile',
  systemPrompt: (context) =>
    typeof context['pluginSections'] === 'string' ? context['pluginSections'] : '',
  tools: [],
});

const skillsProfile: ResolvedAgentProfile = normalizeAgentProfile({
  name: 'skills-profile',
  systemPrompt: (context) => `skills:${context.skills ?? ''}`,
  tools: ['Skill'],
});

const agentsAndPluginsProfile: ResolvedAgentProfile = normalizeAgentProfile({
  name: 'agents-and-plugins-profile',
  systemPrompt: (context) =>
    `agents:${typeof context['agentsMd'] === 'string' ? context['agentsMd'] : ''}\n` +
    `plugins:${context['pluginSections'] ?? ''}`,
  tools: [],
});

const exactProfile: ResolvedAgentProfile = normalizeAgentProfile({
  name: 'exact-profile',
  systemPrompt: (context) =>
    [
      `cwd:${context.cwd ?? ''}`,
      `os:${context.osKind ?? ''}`,
      `shell:${context.shellName ?? ''}:${context.shellPath ?? ''}`,
      `agents:${context.agentsMd ?? ''}`,
      `ls:${context.cwdListing ?? ''}`,
      `extra:${context.additionalDirsInfo ?? ''}`,
    ].join('\n'),
  tools: ['Read', 'Write'],
});

describe('AgentProfileService.applyProfile', () => {
  let ctx: TestAgentContext;
  let homeDir: string;
  let workDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-apply-home-'));
    workDir = await mkdtemp(join(tmpdir(), 'kimi-apply-work-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  function buildContext(
    ...extra: readonly (TestAgentServiceOverride | TestAgentOptions)[]
  ): { ctx: TestAgentContext; profile: IAgentProfileService } {
    const fs = new HostFileSystem();
    ctx = createTestAgent(
      execEnvServices({ hostFs: fs }),
      hostEnvironmentServices(homeDir),
      { cwd: workDir },
      ...extra,
    );
    return { ctx, profile: ctx.get(IAgentProfileService) };
  }

  describe('custom identity', () => {
    // The default builtin profile opens with `You are ${product_name}`.
    const selfNaming: ResolvedAgentProfile = normalizeAgentProfile({
      name: 'self-naming',
      systemPrompt: (context) => `You are ${context.productName ?? DEFAULT_PRODUCT_NAME}`,
      tools: [],
    });

    it('names the agent after the configured identity', async () => {
      const { profile: svc } = buildContext(
        appService(IAgentIdentity, stubAgentIdentity({ displayName: 'Acme Dev', slug: 'acme' })),
      );

      await svc.applyProfile(selfNaming);

      expect(svc.data().systemPrompt).toBe('You are Acme Dev');
    });

    it('keeps the built-in product name when no identity is configured', async () => {
      const { profile: svc } = buildContext(
        appService(IAgentIdentity, stubAgentIdentity()),
      );

      await svc.applyProfile(selfNaming);

      expect(svc.data().systemPrompt).toBe(`You are ${DEFAULT_PRODUCT_NAME}`);
    });
  });

  it('loads AGENTS.md into the rendered system prompt', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');
    const { profile: svc } = buildContext();

    await svc.applyProfile(profile);

    expect(svc.data().systemPrompt).toContain('project instructions');
    expect(svc.data().systemPrompt).toContain(`<!-- From: ${join(workDir, 'AGENTS.md')} -->`);
    expect(svc.getAgentsMdWarning()).toBeUndefined();
  });

  it('renders the complete runtime context exactly', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');
    const { profile: svc } = buildContext();

    await svc.applyProfile(exactProfile);

    expect(svc.data().systemPrompt).toBe(exactSystemPrompt(workDir, 'project instructions'));
  });

  it('refreshes the active profile system prompt exactly without resetting active tools', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'old instructions', 'utf-8');
    const { profile: svc } = buildContext();
    await svc.applyProfile(exactProfile);
    svc.update({ activeToolNames: ['Read'] });
    await writeFile(join(workDir, 'AGENTS.md'), 'new instructions', 'utf-8');

    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toBe(exactSystemPrompt(workDir, 'new instructions'));
    expect(svc.getActiveToolNames()).toEqual(['Read']);
  });

  it('caches an agents-md warning when the content exceeds the 32 KB soft budget', async () => {
    const largeContent = 'x'.repeat(40 * 1024);
    await writeFile(join(workDir, 'AGENTS.md'), largeContent, 'utf-8');
    const { ctx: context, profile: svc } = buildContext();

    await svc.applyProfile(profile);

    expect(svc.data().systemPrompt).toContain(largeContent);
    const warning = svc.getAgentsMdWarning();
    expect(warning).toBeDefined();
    expect(warning).toContain('exceeds the recommended');

    const events = context.newEvents() as readonly {
      event: string;
      args?: { code?: string };
    }[];
    expect(
      events.some(
        (entry) => entry.event === 'warning' && entry.args?.code === 'agents-md-oversized',
      ),
    ).toBe(true);
  });

  it('does not cache a warning when the content is within the budget', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'small instructions', 'utf-8');
    const { profile: svc } = buildContext();

    await svc.applyProfile(profile);

    expect(svc.getAgentsMdWarning()).toBeUndefined();
  });

  it('injects enabled plugin system-prompt sections into the rendered prompt', async () => {
    const sections = {
      value: [{ pluginId: 'demo', content: 'Always cite sources.' }] as readonly EnabledPluginSystemPrompt[],
    };
    const { profile: svc } = buildContext(appService(IPluginService, pluginStub(sections)));

    await svc.applyProfile(pluginProfile);

    expect(svc.data().systemPrompt).toBe(
      '<!-- From: plugin demo -->\nAlways cite sources.',
    );
  });

  it('keeps the rendered prompt frozen when the plugin skill source reloads', async () => {
    const sections = {
      value: [{ pluginId: 'demo', content: 'V1' }] as readonly EnabledPluginSystemPrompt[],
    };
    const change = new Emitter<string>();
    const { profile: svc } = buildContext(
      appService(IPluginService, pluginStub(sections)),
      skillCatalogWithChange(change),
    );
    await svc.applyProfile(pluginProfile);
    const before = svc.data().systemPrompt;
    expect(before).toContain('V1');

    sections.value = [{ pluginId: 'demo', content: 'V2' }];
    change.fire(PLUGIN_SKILL_SOURCE_ID);
    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toBe(before);
    change.dispose();
  });

  it('does not change a live agent prompt when the contributing plugin is uninstalled', async () => {
    const sections = {
      value: [
        { pluginId: 'demo', content: 'Always cite sources.' },
      ] as readonly EnabledPluginSystemPrompt[],
    };
    const { profile: svc } = buildContext(appService(IPluginService, pluginStub(sections)));
    await svc.applyProfile(pluginProfile);
    const before = svc.data().systemPrompt;

    sections.value = []; // plugin uninstalled
    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toBe(before);
  });

  it('does not change a live agent prompt when a plugin is installed', async () => {
    const sections = { value: [] as readonly EnabledPluginSystemPrompt[] };
    const { profile: svc } = buildContext(appService(IPluginService, pluginStub(sections)));
    await svc.applyProfile(pluginProfile);
    const before = svc.data().systemPrompt;

    sections.value = [{ pluginId: 'demo', content: 'Always cite sources.' }];
    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toBe(before);
  });

  // While the initial plugin load has failed, `enabledSystemPrompts()`
  // resolves to its consumption fallback instead of rejecting — that empty
  // read must not freeze, or a later successful reload would never reach
  // the live agent.
  it('freezes plugin sections only once the plugin snapshot has loaded', async () => {
    const sections = { value: [] as readonly EnabledPluginSystemPrompt[] };
    const loaded = { value: false };
    const { profile: svc } = buildContext(appService(IPluginService, pluginStub(sections, loaded)));
    await svc.applyProfile(pluginProfile);
    expect(svc.data().systemPrompt).toBe('');

    loaded.value = true;
    sections.value = [{ pluginId: 'demo', content: 'V1' }];
    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toContain('<!-- From: plugin demo -->');
  });

  it('lets a freshly built agent snapshot the current plugin sections', async () => {
    const sections = {
      value: [{ pluginId: 'demo', content: 'V1' }] as readonly EnabledPluginSystemPrompt[],
    };
    const first = buildContext(appService(IPluginService, pluginStub(sections)));
    await first.profile.applyProfile(pluginProfile);
    expect(first.profile.data().systemPrompt).toContain('V1');

    sections.value = [{ pluginId: 'demo', content: 'V2' }];
    const second = buildContext(appService(IPluginService, pluginStub(sections)));
    await second.profile.applyProfile(pluginProfile);

    expect(second.profile.data().systemPrompt).toContain('V2');
    await first.ctx.dispose();
  });

  it('keeps plugin sections frozen while other prompt inputs still refresh', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'old instructions', 'utf-8');
    const sections = {
      value: [{ pluginId: 'demo', content: 'cite' }] as readonly EnabledPluginSystemPrompt[],
    };
    const { profile: svc } = buildContext(appService(IPluginService, pluginStub(sections)));
    await svc.applyProfile(agentsAndPluginsProfile);
    expect(svc.data().systemPrompt).toContain('old instructions');
    expect(svc.data().systemPrompt).toContain('cite');

    sections.value = [];
    await writeFile(join(workDir, 'AGENTS.md'), 'new instructions', 'utf-8');
    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toContain('new instructions');
    expect(svc.data().systemPrompt).toContain('cite');
  });

  // The skill listing is frozen together with the plugin sections: even the
  // builtin source's reload rebuilds from the frozen listing, so a live
  // agent's prompt stays byte-identical. New agents snapshot the new listing.
  it('keeps the skill listing frozen when the builtin skill source reloads', async () => {
    const change = new Emitter<string>();
    const listing = { value: 'before' };
    const catalog = {
      getModelSkillListing: () => listing.value,
    } as unknown as SkillCatalog;
    const { profile: svc } = buildContext(skillCatalogWithChange(change, catalog));
    await svc.applyProfile(skillsProfile);
    expect(svc.data().systemPrompt).toBe('skills:before');

    listing.value = 'after';
    change.fire(BUILTIN_SKILL_SOURCE_ID);
    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toBe('skills:before');
    change.dispose();
  });

  it('does not rebuild the system prompt when the plugin skill source changes', async () => {
    let renders = 0;
    const countingProfile: ResolvedAgentProfile = normalizeAgentProfile({
      name: 'counting-profile',
      systemPrompt: () => `render:${++renders}`,
      tools: [],
    });
    const change = new Emitter<string>();
    const { profile: svc } = buildContext(skillCatalogWithChange(change));
    await svc.applyProfile(countingProfile);
    expect(svc.data().systemPrompt).toBe('render:1');

    change.fire(PLUGIN_SKILL_SOURCE_ID);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Plugin-derived inputs are frozen for the agent's lifetime, so a plugin
    // source change must not trigger a rebuild at all — a rebuild would only
    // churn `${now}` and invalidate the provider's prompt cache.
    expect(svc.data().systemPrompt).toBe('render:1');
    change.dispose();
  });

  it('rebuilds the system prompt when the builtin skill source changes', async () => {
    let renders = 0;
    const countingProfile: ResolvedAgentProfile = normalizeAgentProfile({
      name: 'counting-profile',
      systemPrompt: () => `render:${++renders}`,
      tools: [],
    });
    const change = new Emitter<string>();
    const { profile: svc } = buildContext(skillCatalogWithChange(change));
    await svc.applyProfile(countingProfile);
    expect(svc.data().systemPrompt).toBe('render:1');

    change.fire(BUILTIN_SKILL_SOURCE_ID);

    await vi.waitFor(() => {
      expect(svc.data().systemPrompt).toBe('render:2');
    });
    change.dispose();
  });

  it('skips plugin sections beyond the aggregate byte budget and warns once', async () => {
    const large = 'x'.repeat(48 * 1024);
    const sections = {
      value: [
        { pluginId: 'first', content: large },
        { pluginId: 'second', content: large },
      ] as readonly EnabledPluginSystemPrompt[],
    };
    const change = new Emitter<string>();
    const { ctx: context, profile: svc } = buildContext(
      appService(IPluginService, pluginStub(sections)),
      skillCatalogWithChange(change),
    );

    await svc.applyProfile(pluginProfile);
    expect(svc.data().systemPrompt).toContain('<!-- From: plugin first -->');
    expect(svc.data().systemPrompt).not.toContain('<!-- From: plugin second -->');

    // A reload-driven re-render reuses the frozen sections: the prompt does
    // not change and the budget warning is not re-emitted.
    sections.value = [...sections.value, { pluginId: 'third', content: 'small' }];
    change.fire(PLUGIN_SKILL_SOURCE_ID);
    await svc.refreshSystemPrompt();

    expect(svc.data().systemPrompt).toContain('<!-- From: plugin first -->');
    expect(svc.data().systemPrompt).not.toContain('<!-- From: plugin second -->');
    expect(svc.data().systemPrompt).not.toContain('<!-- From: plugin third -->');
    const events = context.newEvents() as readonly {
      event: string;
      args?: { code?: string };
    }[];
    const warnings = events.filter(
      (entry) => entry.event === 'warning' && entry.args?.code === 'plugin-sections-oversized',
    );
    expect(warnings).toHaveLength(1);
    change.dispose();
  });
});

function skillCatalogWithChange(
  change: Emitter<string>,
  catalog: SkillCatalog = new InMemorySkillCatalog(),
): TestAgentServiceOverride {
  return sessionService(ISessionSkillCatalog, {
    _serviceBrand: undefined,
    catalog,
    ready: Promise.resolve(),
    onDidChange: change.event,
    load: async () => {},
    reload: async () => {},
    list: async () => [],
  });
}

function pluginStub(
  sections: { value: readonly EnabledPluginSystemPrompt[] },
  loaded: { value: boolean } = { value: true },
): IPluginService {
  return {
    onDidReload: Event.None as IPluginService['onDidReload'],
    hasLoadedSnapshot: () => loaded.value,
    pluginSkillRoots: async () => [],
    enabledSessionStarts: async () => [],
    enabledSystemPrompts: async () => sections.value,
    enabledMcpServers: async () => ({}),
    enabledHooks: async () => [],
    listPluginCommands: async () => [],
  } as unknown as IPluginService;
}

function exactSystemPrompt(workDir: string, agentsMd: string): string {
  return [
    `cwd:${workDir}`,
    'os:Linux',
    'shell:bash:/bin/bash',
    `agents:<!-- From: ${join(workDir, 'AGENTS.md')} -->\n${agentsMd}`,
    'ls:\u2514\u2500\u2500 AGENTS.md',
    'extra:',
  ].join('\n');
}
