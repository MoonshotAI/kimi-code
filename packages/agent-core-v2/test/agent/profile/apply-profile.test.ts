import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AsyncEmitter, Event } from '#/_base/event';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IAgentProfileService, type ResolvedAgentProfile } from '#/agent/profile/profile';
import { IPluginService } from '#/app/plugin/plugin';
import type { EnabledPluginSystemPrompt } from '#/app/plugin/types';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import {
  ISessionPluginContributionService,
  type SessionPluginContributionChangedEvent,
} from '#/session/sessionPluginContribution/sessionPluginContribution';

import {
  appService,
  createTestAgent,
  execEnvServices,
  hostEnvironmentServices,
  InMemoryWireRecordPersistence,
  sessionService,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../../harness';

const profile: ResolvedAgentProfile = {
  name: 'agents-profile',
  systemPrompt: (context) =>
    typeof context['agentsMd'] === 'string' ? (context['agentsMd'] as string) : '',
  tools: [],
};

const pluginProfile: ResolvedAgentProfile = {
  name: 'plugin-profile',
  systemPrompt: (context) =>
    typeof context['pluginSections'] === 'string' ? context['pluginSections'] : '',
  tools: [],
};

const exactProfile: ResolvedAgentProfile = {
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
};

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
    svc.update({ cwd: workDir });
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

  it('refreshes the system prompt when session plugin contributions converge', async () => {
    const sections = {
      value: [{ pluginId: 'demo', content: 'V1' }] as readonly EnabledPluginSystemPrompt[],
    };
    const converge = new AsyncEmitter<SessionPluginContributionChangedEvent>();
    const { profile: svc } = buildContext(
      appService(IPluginService, pluginStub(sections)),
      pluginConvergenceService(converge),
    );
    await svc.applyProfile(pluginProfile);
    expect(svc.data().systemPrompt).toContain('V1');

    sections.value = [{ pluginId: 'demo', content: 'V2' }];
    await converge.fireAsync({}, new AbortController().signal);

    expect(svc.data().systemPrompt).toContain('V2');
    converge.dispose();
  });

  it('dispatches no config record when a plugin-driven refresh changes nothing', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const sections = {
      value: [{ pluginId: 'demo', content: 'V1' }] as readonly EnabledPluginSystemPrompt[],
    };
    const converge = new AsyncEmitter<SessionPluginContributionChangedEvent>();
    const { profile: svc } = buildContext(
      { persistence },
      appService(IPluginService, pluginStub(sections)),
      pluginConvergenceService(converge),
    );
    await svc.applyProfile(pluginProfile);
    const recordsAfterBind = persistence.records.length;

    await converge.fireAsync({}, new AbortController().signal);

    expect(persistence.records.length).toBe(recordsAfterBind);
    expect(svc.data().systemPrompt).toContain('V1');
    converge.dispose();
  });

  it('skips plugin sections beyond the aggregate byte budget and warns once', async () => {
    const large = 'x'.repeat(48 * 1024);
    const sections = {
      value: [
        { pluginId: 'first', content: large },
        { pluginId: 'second', content: large },
      ] as readonly EnabledPluginSystemPrompt[],
    };
    const converge = new AsyncEmitter<SessionPluginContributionChangedEvent>();
    const { ctx: context, profile: svc } = buildContext(
      appService(IPluginService, pluginStub(sections)),
      pluginConvergenceService(converge),
    );

    await svc.applyProfile(pluginProfile);
    await converge.fireAsync({}, new AbortController().signal);

    expect(svc.data().systemPrompt).toContain('<!-- From: plugin first -->');
    expect(svc.data().systemPrompt).not.toContain('<!-- From: plugin second -->');
    const events = context.newEvents() as readonly {
      event: string;
      args?: { code?: string };
    }[];
    const warnings = events.filter(
      (entry) => entry.event === 'warning' && entry.args?.code === 'plugin-sections-oversized',
    );
    expect(warnings).toHaveLength(1);
    converge.dispose();
  });

  it('rebinds the full profile slice when a restored agent refreshes', async () => {
    const rebound: ResolvedAgentProfile = {
      name: 'plugin-profile',
      systemPrompt: (context) =>
        `v2:${typeof context['pluginSections'] === 'string' ? context['pluginSections'] : ''}`,
      tools: ['Read'],
      disallowedTools: ['Bash'],
    };
    const converge = new AsyncEmitter<SessionPluginContributionChangedEvent>();
    const { profile: svc } = buildContext(
      appService(IPluginService, pluginStub({ value: [{ pluginId: 'demo', content: 'P' }] })),
      pluginConvergenceService(converge),
      agentProfileCatalogService([rebound]),
    );
    svc.update({ profileName: 'plugin-profile', systemPrompt: 'old prompt', disallowedTools: [] });
    svc.update({ activeToolNames: ['OldTool'] });

    await converge.fireAsync({}, new AbortController().signal);

    expect(svc.data().systemPrompt).toBe('v2:<!-- From: plugin demo -->\nP');
    expect(svc.data().disallowedTools).toEqual(['Bash']);
    expect(svc.getActiveToolNames()).toEqual(['Read']);
    converge.dispose();
  });

  it('anchors the rendered timestamp at the first render and reuses it across refreshes', async () => {
    const nowProfile: ResolvedAgentProfile = {
      name: 'now-profile',
      systemPrompt: (context) => `now:${context.now ?? ''}`,
      tools: [],
    };
    const converge = new AsyncEmitter<SessionPluginContributionChangedEvent>();
    const { profile: svc } = buildContext(pluginConvergenceService(converge));
    await svc.applyProfile(nowProfile);
    const first = svc.data().systemPrompt;

    await converge.fireAsync({}, new AbortController().signal);
    await converge.fireAsync({}, new AbortController().signal);

    expect(first).toMatch(/^now:\d{4}-\d{2}-\d{2}T/);
    expect(svc.data().systemPrompt).toBe(first);
    converge.dispose();
  });

  it('keeps the persisted binding and warns when the bound profile no longer exists', async () => {
    const converge = new AsyncEmitter<SessionPluginContributionChangedEvent>();
    const { ctx: context, profile: svc } = buildContext(
      pluginConvergenceService(converge),
      agentProfileCatalogService([]),
    );
    svc.update({ profileName: 'ghost', systemPrompt: 'old prompt', disallowedTools: [] });

    await converge.fireAsync({}, new AbortController().signal);
    await converge.fireAsync({}, new AbortController().signal);

    expect(svc.data().systemPrompt).toBe('old prompt');
    const events = context.newEvents() as readonly {
      event: string;
      args?: { code?: string };
    }[];
    const warnings = events.filter(
      (entry) =>
        entry.event === 'warning' &&
        entry.args?.code === 'system-prompt-refresh-profile-missing',
    );
    expect(warnings).toHaveLength(1);
    converge.dispose();
  });
});

function pluginConvergenceService(
  converge: AsyncEmitter<SessionPluginContributionChangedEvent>,
): TestAgentServiceOverride {
  return sessionService(ISessionPluginContributionService, {
    _serviceBrand: undefined,
    onDidChange: converge.event,
  });
}

function agentProfileCatalogService(
  profiles: readonly ResolvedAgentProfile[],
): TestAgentServiceOverride {
  return sessionService(ISessionAgentProfileCatalog, {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
    get: (name: string) => profiles.find((profile) => profile.name === name),
    getDefault: () => profiles[0],
    list: () => profiles,
    load: async () => {},
    reload: async () => {},
  } as unknown as ISessionAgentProfileCatalog);
}

function pluginStub(sections: {
  value: readonly EnabledPluginSystemPrompt[];
}): IPluginService {
  return {
    onDidChange: Event.None as IPluginService['onDidChange'],
    onDidReload: Event.None as IPluginService['onDidReload'],
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
