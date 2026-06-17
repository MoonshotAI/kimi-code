import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILES, loadAgentProfilesFromSources } from '../../src/profile';

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

  it('lists the goal tools on the agent profile but not on subagent profiles', () => {
    const agentTools = DEFAULT_AGENT_PROFILES['agent']?.tools ?? [];
    expect(agentTools).toEqual(expect.arrayContaining(['CreateGoal', 'GetGoal']));
    for (const name of ['coder', 'explore', 'plan', 'reviewer', 'reconciliator']) {
      const tools = DEFAULT_AGENT_PROFILES[name]?.tools ?? [];
      expect(tools).not.toContain('CreateGoal');
      expect(tools).not.toContain('GetGoal');
    }
  });

  it('allowlists the RunCodeReview fan-out tool on the main agent profile', () => {
    // The tool instance is only registered when the code_review flag is on, but
    // it must be in the profile allowlist or it is filtered out before the model
    // ever sees it.
    expect(DEFAULT_AGENT_PROFILES['agent']?.tools).toContain('RunCodeReview');
  });

  it('registers reviewer and reconciliator as narrow read-only subagents', () => {
    expect(Object.keys(DEFAULT_AGENT_PROFILES['agent']?.subagents ?? {})).toEqual(
      expect.arrayContaining(['reviewer', 'reconciliator']),
    );
    expect(DEFAULT_AGENT_PROFILES['reviewer']?.tools).toEqual([
      'GetAssignment',
      'GetChangedFiles',
      'ReadDiff',
      'ReadFileVersion',
      'UpdateProgress',
      'AddComment',
      'Grep',
      'Glob',
    ]);
    expect(DEFAULT_AGENT_PROFILES['reconciliator']?.tools).toEqual([
      'GetComments',
      'GetCommentEvidence',
      'MergeComments',
      'DismissComment',
      'UpdateProgress',
      'ReadDiff',
      'ReadFileVersion',
    ]);
  });

  it('fails loudly when an embedded system prompt source is missing', () => {
    expect(() =>
      loadAgentProfilesFromSources(['profile/default/agent.yaml'], {
        'profile/default/agent.yaml': 'name: agent\nsystemPromptPath: ./missing.md\n',
      }),
    ).toThrow(/Embedded agent profile source missing: profile\/default\/missing\.md/);
  });
});
