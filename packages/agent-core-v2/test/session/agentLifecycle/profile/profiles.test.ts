import { describe, expect, it } from 'vitest';

import { getAgentProfileContributions } from '#/app/agentProfileCatalog/contribution';
import '#/features/plan/profile/plan';
import '#/session/agentLifecycle/profile/profiles';

function profile(name: string) {
  const found = getAgentProfileContributions().find((p) => p.name === name);
  expect(found, `builtin profile "${name}" is registered`).toBeDefined();
  return found!;
}

describe('builtin agent profiles', () => {
  it('wires the tower control tools into the default profile', () => {
    const agent = profile('agent');
    expect(agent.tools).toContain('TowerInit');
    expect(agent.tools).toContain('TowerStatus');
    expect(agent.tools).toContain('TowerTeardown');
  });

  it('caps the default profile delegation at non-spawning profiles', () => {
    const agent = profile('agent');
    expect(agent.subagents).toEqual(['coder', 'explore', 'plan']);
  });

  it('keeps plan mode entry out of every builtin profile and plan review on the default one', () => {
    for (const builtin of getAgentProfileContributions()) {
      expect(builtin.tools ?? []).not.toContain('EnterPlanMode');
    }
    expect(profile('agent').tools).toContain('ExitPlanMode');
    expect(profile('coder').tools).not.toContain('ExitPlanMode');
  });

  it('uses read-only prompts for explore and plan while preserving AGENTS.md', () => {
    const coderPrompt = profile('coder').renderSystemPrompt({ agentsMd: 'AGENTS' }).text;
    expect(coderPrompt).toContain('# Coding');
    expect(coderPrompt).toContain('Before you call a change done');
    expect(coderPrompt).toContain('# Project information');
    expect(coderPrompt).toContain('AGENTS');

    for (const name of ['explore', 'plan']) {
      const prompt = profile(name).renderSystemPrompt({ agentsMd: 'AGENTS' }).text;
      expect(prompt).not.toContain('# Coding');
      expect(prompt).not.toContain('Before you call a change done');
      expect(prompt).toContain('distinguish confirmed findings from hypotheses');
      expect(prompt).toContain('# Project information');
      expect(prompt).toContain('AGENTS');
    }
  });

  it('renders the explore subagent role once', () => {
    const prompt = profile('explore').renderSystemPrompt({}).text;

    expect(prompt.split('You are a subagent;')).toHaveLength(2);
  });
});
