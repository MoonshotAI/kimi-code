import { describe, expect, it } from 'vitest';

import { TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { visibleBuiltinSkills } from '#/app/skillCatalog/builtin/builtin';
import { BuiltinSkillSource } from '#/app/skillCatalog/builtinSkillSource';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import { TOWER_FLAG_ID } from '#/features/tower/tower';
import { TOWER_SKILL } from '#/features/tower/skill/skill';

import { stubFlag } from '../flag/stubs';
import { StubConfigService } from '../../kosong/stubs';

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

  it('ships enabled for every product (not gated by the product-skills switch)', () => {
    expect(TOWER_SKILL.productSpecific).not.toBe(true);
    expect(visibleBuiltinSkills(true)).toContain(TOWER_SKILL);
    expect(visibleBuiltinSkills(false)).toContain(TOWER_SKILL);
  });

  it('declares the tower experimental flag as its gate', () => {
    expect(TOWER_SKILL.experimentalFlag).toBe(TOWER_FLAG_ID);
  });

  it('is filtered out of the builtin source while the tower flag is off', async () => {
    for (const flagOn of [false, true]) {
      const ix = new TestInstantiationService();
      ix.set(IConfigService, new StubConfigService({}));
      ix.set(IFlagService, stubFlag((id) => flagOn && id === TOWER_FLAG_ID));
      const source = ix.createInstance(BuiltinSkillSource);
      const names = (await source.load()).skills.map((skill) => skill.name);
      expect(names.includes('tower')).toBe(flagOn);
    }
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

  it('registers into the catalog but stays out of the invocable listing', () => {
    const catalog = new InMemorySkillCatalog();
    catalog.registerBuiltinSkill(TOWER_SKILL);

    expect(catalog.getSkill('tower')).toBeDefined();
    expect(catalog.listSkills().some((skill) => skill.name === 'tower')).toBe(true);
    expect(catalog.listInvocableSkills().some((skill) => skill.name === 'tower')).toBe(false);
  });

  it('expands $ARGUMENTS as the user objective when rendering', () => {
    const catalog = new InMemorySkillCatalog();
    catalog.registerBuiltinSkill(TOWER_SKILL);
    const skill = catalog.getSkill('tower');
    expect(skill).toBeDefined();

    const rendered = catalog.renderSkillPrompt(skill!, 'split auth and ui refactors');
    expect(rendered).toContain('split auth and ui refactors');
  });
});
