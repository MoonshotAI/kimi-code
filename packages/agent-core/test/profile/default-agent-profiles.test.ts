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
    for (const name of ['coder', 'explore', 'plan']) {
      const tools = DEFAULT_AGENT_PROFILES[name]?.tools ?? [];
      expect(tools).not.toContain('CreateGoal');
      expect(tools).not.toContain('GetGoal');
    }
  });

  it('fails loudly when an embedded system prompt source is missing', () => {
    expect(() =>
      loadAgentProfilesFromSources(['profile/default/agent.yaml'], {
        'profile/default/agent.yaml': 'name: agent\nsystemPromptPath: ./missing.md\n',
      }),
    ).toThrow(/Embedded agent profile source missing: profile\/default\/missing\.md/);
  });

  it('omits the Skills section for subagent profiles that lack the Skill tool', () => {
    // The root agent has the Skill tool, so the Skills section and listing render.
    const agentPrompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';
    expect(agentPrompt).toContain('# Skills');
    expect(agentPrompt).toContain('- test-skill: does things');

    // Subagents (coder/explore/plan) lack the Skill tool, so neither the section
    // heading nor the skill listing should appear in their prompt.
    for (const name of ['coder', 'explore', 'plan']) {
      const tools = DEFAULT_AGENT_PROFILES[name]?.tools ?? [];
      expect(tools).not.toContain('Skill');
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).not.toContain('# Skills');
      expect(prompt).not.toContain('- test-skill: does things');
    }
  });

  it('keeps optional-tool guidance out of the shared system prompt entirely', () => {
    // Tool-coupled guidance now lives in each tool's own description, which the schema
    // layer ships ONLY when the tool is registered — that is the availability gate, for
    // free. So the shared system.md must not name optional tools at all (no per-tool
    // {% if %} reconstruction of availability). This holds for the root `agent` too, not
    // just subagents. The cross-tool secret-file guard — built on the always-present
    // Read/Grep/Glob — stays shared.
    for (const name of ['agent', 'coder', 'explore', 'plan']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).not.toContain('Launch multiple explore agents concurrently'); // Agent → agent.md + explore whenToUse
      expect(prompt).not.toContain('long-running shell commands as background tasks'); // background → bash.md
      expect(prompt).not.toContain('maintain a `TodoList`'); // TodoList → todo-list.md
      expect(prompt).not.toContain('prefer entering plan mode first'); // EnterPlanMode → enter-plan-mode.md
      expect(prompt).not.toContain('call `TaskList` to re-enumerate'); // compaction recovery → task-list.md
      // The dedicated-tool routing must name only universally-present tools (Read/Glob/Grep).
      // Write/Edit/Bash are absent from read-only profiles (plan has no Bash/Write/Edit;
      // explore no Write/Edit), so naming them in the shared routing sentence would dangle —
      // that routing lives in bash.md (echo>file→Write, sed→Edit, etc.), which ships with Bash.
      expect(prompt).not.toContain('`Write` / `Edit` to change files');
      expect(prompt).not.toContain('Keep `Bash` for genuine shell work');
      expect(prompt).toContain('`Glob` to find files by name'); // universal routing stays
      expect(prompt).toContain('refuse a fixed set of well-known secret files'); // shared guard stays
    }
  });

  it('renders blast-radius and concrete-example guidance for root and subagents alike', () => {
    // These additions live in shared, ungated sections, so the root agent AND every
    // subagent that renders the coding guidelines must carry them verbatim.
    for (const name of ['agent', 'coder', 'explore', 'plan']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      // Reversibility / blast-radius principle generalized beyond the git rule.
      expect(prompt).toContain('reversibility and blast radius');
      expect(prompt).toContain('A one-time approval covers that one action');
      // Concrete one-line examples anchoring high-frequency abstract rules.
      expect(prompt).toContain('locate the method in the code'); // ambiguous instruction -> edit code, not echo text
      expect(prompt).toContain('update the related tests'); // preamble phrasing example
      expect(prompt).toContain('premature abstraction'); // MINIMAL-changes counterexample
    }
  });
});
