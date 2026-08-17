import { describe, expect, it } from 'vitest';

import { getAgentProfileContributions } from '#/app/agentProfileCatalog/contribution';
import { TOWER_WORKER_PROFILE_DEF } from '#/features/tower/workerProfile';
import '#/session/agentLifecycle/profile/profiles';

function builtinProfile(name: string) {
  const found = getAgentProfileContributions().find((p) => p.name === name);
  expect(found, `builtin profile "${name}" is registered`).toBeDefined();
  return found!;
}

describe('tower-worker profile', () => {
  it('gives tower-worker the coder tools (minus AgentSwarm) plus the six shared tower tools', () => {
    const coder = builtinProfile('coder');
    const tools = TOWER_WORKER_PROFILE_DEF.tools ?? [];

    for (const name of coder.tools ?? []) {
      if (name === 'AgentSwarm') continue;
      expect(tools).toContain(name);
    }
    expect(tools).not.toContain('AgentSwarm');
    expect(TOWER_WORKER_PROFILE_DEF.subagents).toEqual(['explore', 'plan']);
    for (const name of [
      'TowerSend',
      'TowerInbox',
      'TowerFinding',
      'TowerReview',
      'TowerMission',
      'TowerStatus',
    ]) {
      expect(tools).toContain(name);
    }
    for (const name of ['TowerInit', 'TowerPlan', 'TowerSpawn', 'TowerMerge', 'TowerTeardown']) {
      expect(tools).not.toContain(name);
    }
  });

  it('renders the coder base role plus the tower worker overlay', () => {
    const prompt = TOWER_WORKER_PROFILE_DEF.systemPrompt({});
    expect(prompt).toContain('tower worker/reviewer');
    expect(prompt).toContain('Tower* tools ONLY');
    expect(prompt).toContain('You are now running as a subagent.');
    expect(prompt).toContain('Your final message is the entire handoff');
  });

  it('keeps the coder summary policy and ports the description', () => {
    const coder = builtinProfile('coder');
    expect(TOWER_WORKER_PROFILE_DEF.summaryPolicy).toEqual(coder.summaryPolicy);
    expect(TOWER_WORKER_PROFILE_DEF.summaryPolicy).toBeDefined();
    expect(TOWER_WORKER_PROFILE_DEF.description).toContain('Tower worker/reviewer');
    expect(TOWER_WORKER_PROFILE_DEF.whenToUse).toBe(coder.whenToUse);
  });
});
