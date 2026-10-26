import { describe, expect, it } from 'vitest';

import { getAgentProfileContributions } from '#/app/agentProfileCatalog/contribution';
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
});
