import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_PROFILE_NAME,
  normalizeAgentProfile,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  SYSTEM_MD_FILENAME,
  loadSystemMdProfile,
} from '#/workspace/workspaceAgentProfileLoader/internal/systemFile';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';

const hostFs = new HostFileSystem();

const BUILTIN_DEFAULT: AgentProfile = normalizeAgentProfile({
  name: DEFAULT_AGENT_PROFILE_NAME,
  description: 'builtin default description',
  tools: ['Read', 'Skill', 'Bash'],
  disallowedTools: ['Write'],
  systemPrompt: () => 'BUILTIN PROMPT',
});

function collectWarnings(): { warnings: string[]; warn: (message: string) => void } {
  const warnings: string[] = [];
  return { warnings, warn: (message) => warnings.push(message) };
}

describe('loadSystemMdProfile', () => {
  let home: string;

  function loadProfile(
    fs: IHostFileSystem,
    builtinDefault: AgentProfile,
    warn: (message: string) => void,
  ) {
    return loadSystemMdProfile(fs, home, builtinDefault, warn);
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'system-md-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('returns undefined when SYSTEM.md does not exist', async () => {
    const { warnings, warn } = collectWarnings();
    expect(await loadProfile(hostFs, BUILTIN_DEFAULT, warn)).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('returns undefined when SYSTEM.md is empty or whitespace-only', async () => {
    await writeFile(join(home, SYSTEM_MD_FILENAME), ' \n\n');
    const { warn } = collectWarnings();
    expect(await loadProfile(hostFs, BUILTIN_DEFAULT, warn)).toBeUndefined();
  });

  it('degrades to a warning when the file cannot be read', async () => {
    const unreadableFs = {
      realpath: async (p: string) => p,
      stat: async () => ({ isFile: true }),
      readText: async () => {
        throw new Error('disk gone');
      },
    } as unknown as IHostFileSystem;
    const { warnings, warn } = collectWarnings();

    expect(await loadProfile(unreadableFs, BUILTIN_DEFAULT, warn)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SYSTEM.md');
  });

  it('degrades to a warning when the SYSTEM.md type probe is denied', async () => {
    const unreadableFs = {
      realpath: async () => {
        throw new HostFsError(
          OsFsErrors.codes.OS_FS_PERMISSION_DENIED,
          'realpath failed: permission denied',
        );
      },
    } as unknown as IHostFileSystem;
    const { warnings, warn } = collectWarnings();

    expect(await loadProfile(unreadableFs, BUILTIN_DEFAULT, warn)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SYSTEM.md');
  });

  it('synthesizes a default-named override profile that inherits the builtin shape', async () => {
    await writeFile(join(home, SYSTEM_MD_FILENAME), 'You are a custom main agent.');
    const { warn } = collectWarnings();

    const profile = await loadProfile(hostFs, BUILTIN_DEFAULT, warn);

    expect(profile?.name).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(profile?.override).toBe(true);
    expect(profile?.description).toBe('builtin default description');
    expect(profile?.tools).toEqual(['Read', 'Skill', 'Bash']);
    expect(profile?.disallowedTools).toEqual(['Write']);
    expect(profile?.systemPrompt({})).toBe('You are a custom main agent.');
  });

  it('empties ${skills} when the builtin default disables the Skill tool', async () => {
    await writeFile(join(home, SYSTEM_MD_FILENAME), 'skills=${skills}');
    const noSkillBuiltin: AgentProfile = normalizeAgentProfile({
      name: DEFAULT_AGENT_PROFILE_NAME,
      description: 'builtin without Skill',
      tools: ['Read', 'Bash'],
      systemPrompt: () => 'BUILTIN PROMPT',
    });
    const { warn } = collectWarnings();

    const profile = await loadProfile(hostFs, noSkillBuiltin, warn);

    expect(profile?.systemPrompt({ skills: 'SKILLS' })).toBe('skills=');
  });

  it('embeds the builtin default prompt via ${base_prompt}', async () => {
    await writeFile(join(home, SYSTEM_MD_FILENAME), 'custom header\n\n${base_prompt}');
    const { warn } = collectWarnings();

    const profile = await loadProfile(hostFs, BUILTIN_DEFAULT, warn);

    expect(profile?.systemPrompt({})).toBe('custom header\n\nBUILTIN PROMPT');
  });

  it('places plugin instructions where ${plugin_sections} is referenced', async () => {
    await writeFile(join(home, SYSTEM_MD_FILENAME), 'before\n${plugin_sections}after');
    const { warn } = collectWarnings();

    const profile = await loadProfile(hostFs, BUILTIN_DEFAULT, warn);
    const prompt = profile?.systemPrompt({ pluginSections: 'PLUGIN_INSTRUCTIONS' });

    expect(prompt).toContain('before');
    expect(prompt).toContain('# Plugin Instructions');
    expect(prompt).toContain('PLUGIN_INSTRUCTIONS');
    expect(prompt).toContain('after');
  });

  it('substitutes ${additional_dirs_info} from the context', async () => {
    await writeFile(join(home, SYSTEM_MD_FILENAME), 'dirs=${additional_dirs_info}');
    const { warn } = collectWarnings();

    const profile = await loadProfile(hostFs, BUILTIN_DEFAULT, warn);

    expect(profile?.systemPrompt({ additionalDirsInfo: '/extra' })).toBe('dirs=/extra');
  });
});
