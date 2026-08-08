import { describe, expect, it } from 'vitest';

import { TOWER_SKILL, SessionSkillRegistry, registerBuiltinSkills } from '../../src/skill';

describe('builtin skill: tower', () => {
  it('has the expected identity and inline metadata', () => {
    expect(TOWER_SKILL.name).toBe('tower');
    expect(TOWER_SKILL.source).toBe('builtin');
    expect(TOWER_SKILL.description.length).toBeGreaterThan(0);
    expect(TOWER_SKILL.metadata.type).toBe('inline');
  });

  it('is hidden from model invocation (user starts tower explicitly)', () => {
    expect(TOWER_SKILL.metadata.disableModelInvocation).toBe(true);
  });

  it('opts into busy activation (the tower coordinates a running turn)', () => {
    expect(TOWER_SKILL.metadata.allowActivationWhileBusy).toBe(true);
  });

  it('defines the three roles and routes every protocol action through Tower tools', () => {
    const content = TOWER_SKILL.content;
    expect(content).toContain('**The tower**');
    expect(content).toContain('**Workers and reviewers**');
    for (const tool of [
      'TowerInit',
      'TowerPlan',
      'TowerSpawn',
      'TowerSend',
      'TowerInbox',
      'TowerFinding',
      'TowerReview',
      'TowerMission',
      'TowerMerge',
      'TowerStatus',
      'TowerTeardown',
    ]) {
      expect(content).toContain(tool);
    }
  });

  it('declares the protocol code-enforced and forbids hand-written comms files', () => {
    const content = TOWER_SKILL.content;
    expect(content).toContain('enforced by tools, not by instructions');
    expect(content).toContain('Never create or edit files under `.tower/` by hand');
    expect(content).toContain('log/activity.log');
  });

  it('never blocks on human approval — no gates, inform and proceed', () => {
    const content = TOWER_SKILL.content;
    expect(content).toContain('Never block on the human');
    expect(content).not.toContain('wait for explicit approval');
  });

  it('lets the tower clarify up front but keeps workers ask-less, naming the return channels', () => {
    const content = TOWER_SKILL.content;
    expect(content).toContain('Use `AskUserQuestion` to pin down requirements');
    expect(content).toContain('their profile has no `AskUserQuestion`');
    expect(content).toContain('activity.log');
  });

  it('forbids TodoList mission tracking and demands parallel spawning', () => {
    const content = TOWER_SKILL.content;
    expect(content).toContain('never in `TodoList`');
    expect(content).toContain('spawn every dependency-unblocked mission right away');
    expect(content).toContain('end your turn');
  });

  it('lets workers negotiate peer-to-peer instead of tower relay', () => {
    const content = TOWER_SKILL.content;
    expect(content).toContain('Agents negotiate internally');
    expect(content).toContain('not a content relay');
  });

  it('initializes git itself for empty dirs but never blind-commits user files', () => {
    const content = TOWER_SKILL.content;
    expect(content).toContain('git commit --allow-empty');
    expect(content).toContain('never `git add -A`');
    expect(content).toContain('exactly once');
  });

  it('keeps merge decisions behind TowerMerge and re-review after rebase', () => {
    const content = TOWER_SKILL.content;
    expect(content).toContain('TowerMerge(branch)');
    expect(content).toContain('rebase');
    expect(content).toContain('Dependency Flow');
  });

  it('tells the tower to teardown promptly once every mission is merged', () => {
    const content = TOWER_SKILL.content;
    expect(content).toContain('Teardown promptly');
    expect(content).toContain('TowerTeardown');
    expect(content).toContain('right away');
  });

  it('registers through registerBuiltinSkills but stays out of the model skill listing', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);

    expect(registry.getSkill('tower')).toBeDefined();
    expect(registry.listInvocableSkills().some((skill) => skill.name === 'tower')).toBe(false);
    expect(registry.listSkills().some((skill) => skill.name === 'tower')).toBe(true);
  });

  it('expands $ARGUMENTS as the user objective when rendering', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);
    const skill = registry.getSkill('tower');
    expect(skill).toBeDefined();

    const rendered = registry.renderSkillPrompt(skill!, 'split auth and ui refactors');
    expect(rendered).toContain('split auth and ui refactors');
  });
});
