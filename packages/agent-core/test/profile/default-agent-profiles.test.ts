import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILES, loadAgentProfilesFromSources } from '../../src/profile';
import {
  ADDITIONAL_DIRS_SECTION_PROSE,
  SKILLS_SECTION_PROSE,
  WINDOWS_NOTES,
} from '../../src/profile/prompt-sections';

const promptContext = {
  osEnv: {
    osKind: 'macOS',
    osArch: 'arm64',
    osVersion: '0',
    shellName: 'bash',
    shellPath: '/bin/bash',
  },
  cwd: '/workspace',
  now: '2026-05-09T00:00:00.000Z',
  cwdListing: 'LISTING_SNAPSHOT',
  agentsMd: 'AGENTS_MD_BODY',
  skills: '- test-skill: does things\n  Path: /skills/test/SKILL.md',
} as const;

describe('default agent profiles', () => {
  it('loads the bundled default system prompt from embedded sources', () => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext);

    expect(prompt).toContain('You are Kimi Code CLI');
    expect(prompt).toContain('Available skills');
    expect(prompt).toContain('/workspace');
  });

  it('keeps static instructions before dynamic prompt context', () => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';

    expect(prompt.indexOf('Use this as your basic understanding of the project structure.')).toBeLessThan(
      prompt.indexOf('LISTING_SNAPSHOT'),
    );
    expect(prompt.indexOf('User instructions given directly in the conversation')).toBeLessThan(
      prompt.indexOf('AGENTS_MD_BODY'),
    );
    expect(prompt.indexOf('Only read skill details when needed')).toBeLessThan(
      prompt.indexOf('- test-skill: does things'),
    );
  });

  it('renders the environment prose sections from the shared prompt-sections source', () => {
    // system.md must render the shared constants (never re-inlined copies), so
    // the builtin default prompt and the agent-file renderer cannot drift.
    const prompt =
      DEFAULT_AGENT_PROFILES['agent']?.systemPrompt({
        ...promptContext,
        osEnv: { ...promptContext.osEnv, osKind: 'Windows' },
        additionalDirsInfo: 'EXTRA_DIR_1',
      }) ?? '';
    expect(prompt).toContain(WINDOWS_NOTES);
    expect(prompt).toContain(ADDITIONAL_DIRS_SECTION_PROSE);
    expect(prompt).toContain(SKILLS_SECTION_PROSE);
  });

  it('lists the goal tools on the agent profile but not on subagent profiles', () => {
    const agentTools = DEFAULT_AGENT_PROFILES['agent']?.tools ?? [];
    expect(agentTools).toEqual(
      expect.arrayContaining(['CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal']),
    );
    for (const name of ['coder', 'explore', 'plan']) {
      const tools = DEFAULT_AGENT_PROFILES[name]?.tools ?? [];
      expect(tools).not.toContain('CreateGoal');
      expect(tools).not.toContain('GetGoal');
      expect(tools).not.toContain('SetGoalBudget');
      expect(tools).not.toContain('UpdateGoal');
    }
  });

  it('fails loudly when an embedded system prompt source is missing', () => {
    expect(() =>
      loadAgentProfilesFromSources(['profile/default/agent.yaml'], {
        'profile/default/agent.yaml': 'name: agent\nsystemPromptPath: ./missing.md\n',
      }),
    ).toThrow(/Embedded agent profile source missing: profile\/default\/missing\.md/);
  });

  it('omits the Skills section only for profiles that lack the Skill tool', () => {
    // The root agent and coder have the Skill tool, so the Skills section and
    // listing render in their prompts.
    for (const name of ['agent', 'coder']) {
      expect(DEFAULT_AGENT_PROFILES[name]?.tools).toContain('Skill');
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).toContain('# Skills');
      expect(prompt).toContain('- test-skill: does things');
    }

    // explore/plan lack the Skill tool, so neither the section heading nor the
    // skill listing should appear in their prompts.
    for (const name of ['explore', 'plan']) {
      const tools = DEFAULT_AGENT_PROFILES[name]?.tools ?? [];
      expect(tools).not.toContain('Skill');
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).not.toContain('# Skills');
      expect(prompt).not.toContain('- test-skill: does things');
    }
  });

  it('renders the Plugin Instructions section only when plugin sections exist', () => {
    const pluginSections = '<!-- From: plugin demo -->\nAlways cite sources.';
    for (const name of ['agent', 'coder', 'explore', 'plan']) {
      const prompt =
        DEFAULT_AGENT_PROFILES[name]?.systemPrompt({ ...promptContext, pluginSections }) ?? '';
      expect(prompt).toContain('# Plugin Instructions');
      expect(prompt).toContain('<!-- From: plugin demo -->');
      expect(prompt).toContain('Always cite sources.');
    }

    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';
    expect(prompt).not.toContain('# Plugin Instructions');
  });

  it('renders the shared coding guidelines identically for root and subagents', () => {
    // The shared, ungated sections must reach every default profile byte-identically.
    // The sharing is the contract; the wording is free to evolve — do not pin prose.
    const root = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';
    const shared = root.match(/# General Guidelines for Coding[\s\S]*?(?=\n# )/)?.[0];
    if (shared === undefined) throw new Error('shared coding guidelines section not found');
    for (const name of ['coder', 'explore', 'plan']) {
      expect(DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '').toContain(shared);
    }
  });
});
