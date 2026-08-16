import { describe, expect, it } from 'vitest';
import type { SkillSummary } from '@moonshot-ai/kimi-code-sdk';
import { buildSkillGroupTree, findGroupNode } from '../../../src/tui/commands/skill-group-tree';

function makeSkill(name: string, overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name,
    description: `${name} description`,
    path: `/test/skills/${name}/SKILL.md`,
    source: 'user',
    type: 'prompt',
    ...overrides,
  };
}

describe('skill-group-tree', () => {
  it('builds group tree from explicit groups metadata', () => {
    const sshOps = makeSkill('cv_ssh-ops', {
      groups: ['cv', 'cv/ops'],
    });
    const semaphoreOps = makeSkill('cv_semaphore-ops', {
      groups: ['cv', 'cv/ops', 'cv/ops/semaphore'],
    });

    const root = buildSkillGroupTree([sshOps, semaphoreOps]);

    const cvNode = findGroupNode(root, 'cv');
    expect(cvNode).toBeDefined();
    expect(cvNode?.label).toBe('cv');
    expect(cvNode?.skills.map((s) => s.name)).toEqual(['cv_semaphore-ops', 'cv_ssh-ops']);

    const opsNode = findGroupNode(root, 'cv/ops');
    expect(opsNode).toBeDefined();
    expect(opsNode?.label).toBe('ops');
    expect(opsNode?.skills.map((s) => s.name)).toEqual(['cv_semaphore-ops', 'cv_ssh-ops']);

    const semNode = findGroupNode(root, 'cv/ops/semaphore');
    expect(semNode).toBeDefined();
    expect(semNode?.label).toBe('semaphore');
    expect(semNode?.skills.map((s) => s.name)).toEqual(['cv_semaphore-ops']);
  });

  it('implies parent groups when only child group path is specified', () => {
    const skill = makeSkill('deep-skill', {
      groups: ['a/b/c'],
    });
    const root = buildSkillGroupTree([skill]);

    const a = findGroupNode(root, 'a');
    expect(a).toBeDefined();
    expect(a?.childGroups.map((g) => g.label)).toEqual(['b']);
    expect(a?.skills).toEqual([]);

    const b = findGroupNode(root, 'a/b');
    expect(b).toBeDefined();
    expect(b?.childGroups.map((g) => g.label)).toEqual(['c']);
    expect(b?.skills).toEqual([]);

    const c = findGroupNode(root, 'a/b/c');
    expect(c).toBeDefined();
    expect(c?.skills.map((s) => s.name)).toEqual(['deep-skill']);
  });

  it('falls back to category when groups are absent', () => {
    const deploySkill = makeSkill('deploy-app', { category: 'deploy' });
    const root = buildSkillGroupTree([deploySkill]);

    const node = findGroupNode(root, 'deploy');
    expect(node).toBeDefined();
    expect(node?.skills.map((s) => s.name)).toEqual(['deploy-app']);
  });

  it('falls back to relative folder path when groups and category are absent', () => {
    const secSkill = makeSkill('owasp-audit', {
      path: '/home/user/.kimi/skills/security/owasp-audit/SKILL.md',
    });
    const root = buildSkillGroupTree([secSkill], { skillRoots: ['/home/user/.kimi/skills'] });

    const secNode = findGroupNode(root, 'security');
    expect(secNode).toBeDefined();
    expect(secNode?.skills.map((s) => s.name)).toEqual(['owasp-audit']);
  });

  it('falls back to Uncategorized when no group/category/folder is present', () => {
    const flatSkill = makeSkill('flat-skill', {
      path: '/SKILL.md',
    });
    const root = buildSkillGroupTree([flatSkill]);

    const uncatNode = findGroupNode(root, 'Uncategorized');
    expect(uncatNode).toBeDefined();
    expect(uncatNode?.skills.map((s) => s.name)).toEqual(['flat-skill']);
  });

  it('preserves deterministic alphabetical ordering of groups and skills', () => {
    const bSkill = makeSkill('b_skill', { category: 'ops' });
    const aSkill = makeSkill('a_skill', { category: 'ops' });
    const cSkill = makeSkill('c_skill', { category: 'dev' });

    const root = buildSkillGroupTree([bSkill, aSkill, cSkill]);

    expect(root.childGroups.map((g) => g.label)).toEqual(['dev', 'ops']);
    const opsNode = findGroupNode(root, 'ops');
    expect(opsNode?.skills.map((s) => s.name)).toEqual(['a_skill', 'b_skill']);
  });
});
