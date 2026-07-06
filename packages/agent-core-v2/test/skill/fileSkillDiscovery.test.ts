import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { dirname, join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileSkillDiscovery } from '#/app/skillCatalog/fileSkillDiscovery';
import type { SkillRoot } from '#/app/skillCatalog/types';

describe('FileSkillDiscovery', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-store-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeSkill(rel: string, frontmatter: string, body = 'body'): Promise<void> {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, `---\n${frontmatter}\n---\n${body}`);
  }

  function skillRoot(rel: string, source: SkillRoot['source'] = 'project'): SkillRoot {
    return { path: join(root, rel), source };
  }

  it('discovers a directory skill under a root', async () => {
    await writeSkill('skills/commit/SKILL.md', 'name: commit\ndescription: commit changes');

    const result = await new FileSkillDiscovery().discover([skillRoot('skills')]);

    expect(result.skills.map((s) => s.name)).toEqual(['commit']);
    expect(result.skills[0]?.source).toBe('project');
  });

  it('returns an empty result when given no roots', async () => {
    const result = await new FileSkillDiscovery().discover([]);

    expect(result.skills).toEqual([]);
    expect(result.scannedRoots).toEqual([]);
  });

  it('discovers a flat .md skill at the root top level', async () => {
    await writeSkill('skills/summarize.md', 'name: summarize\ndescription: summarize text');

    const result = await new FileSkillDiscovery().discover([skillRoot('skills')]);

    expect(result.skills.map((s) => s.name)).toEqual(['summarize']);
  });

  it('lets the first root win over a later sibling root on name collision', async () => {
    await writeSkill('brand/dup/SKILL.md', 'name: dup\ndescription: from brand');
    await writeSkill('generic/dup/SKILL.md', 'name: dup\ndescription: from generic');

    const result = await new FileSkillDiscovery().discover([
      skillRoot('brand'),
      skillRoot('generic'),
    ]);

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.description).toBe('from brand');
  });

  it('discovers sub-skills of a parent that opts in', async () => {
    await writeSkill(
      'skills/parent/SKILL.md',
      'name: parent\ndescription: parent\nhas-sub-skill: true',
    );
    await writeSkill('skills/parent/child/SKILL.md', 'name: child\ndescription: child skill');

    const result = await new FileSkillDiscovery().discover([skillRoot('skills')]);
    const names = result.skills.map((s) => s.name).toSorted();

    expect(names).toEqual(['parent', 'parent.child']);
    expect(result.skills.find((s) => s.name === 'parent.child')?.metadata.isSubSkill).toBe(true);
  });

  it('ignores node_modules and dot directories while walking', async () => {
    await writeSkill(
      'skills/node_modules/hidden/SKILL.md',
      'name: hidden\ndescription: hidden',
    );

    const result = await new FileSkillDiscovery().discover([skillRoot('skills')]);

    expect(result.skills.map((s) => s.name)).not.toContain('hidden');
  });
});
