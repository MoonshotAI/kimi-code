import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Emitter } from '#/_base/event';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IAgentProfileService, type ResolvedAgentProfile } from '#/agent/profile/profile';
import { IPluginService } from '#/app/plugin/plugin';
import type { EnabledPluginSystemPrompt, ReloadSummary } from '#/app/plugin/types';

import { appService, createTestAgent, execEnvServices, hostEnvironmentServices, type TestAgentContext, type TestAgentServiceOverride } from '../../harness';

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
    ...extra: readonly TestAgentServiceOverride[]
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
    const reload = new Emitter<ReloadSummary>();
    const { profile: svc } = buildContext(appService(IPluginService, pluginStub(sections, reload)));

    await svc.applyProfile(pluginProfile);

    expect(svc.data().systemPrompt).toBe(
      '<!-- From: plugin demo -->\nAlways cite sources.',
    );
    reload.dispose();
  });

  it('refreshes the system prompt when plugins reload', async () => {
    const sections = {
      value: [{ pluginId: 'demo', content: 'V1' }] as readonly EnabledPluginSystemPrompt[],
    };
    const reload = new Emitter<ReloadSummary>();
    const { profile: svc } = buildContext(appService(IPluginService, pluginStub(sections, reload)));
    await svc.applyProfile(pluginProfile);
    expect(svc.data().systemPrompt).toContain('V1');

    sections.value = [{ pluginId: 'demo', content: 'V2' }];
    reload.fire({ added: ['demo'], removed: [], errors: [] });

    await vi.waitFor(() => {
      expect(svc.data().systemPrompt).toContain('V2');
    });
    reload.dispose();
  });
});

function pluginStub(
  sections: { value: readonly EnabledPluginSystemPrompt[] },
  reload: Emitter<ReloadSummary>,
): IPluginService {
  return {
    onDidReload: reload.event,
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
