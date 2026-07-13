/**
 * Scenario: filesystem-backed skill discovery across ordered roots.
 *
 * Verifies real SKILL.md parsing, collision handling, nested bundles, and
 * diagnostics through the ISkillDiscovery contract with only logging stubbed.
 * Run with `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/skillCatalog/fileSkillDiscovery.test.ts`.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { dirname, join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { ILogService, type LogPayload } from '#/_base/log/log';
import { FileSkillDiscovery } from '#/app/skillCatalog/fileSkillDiscovery';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import type { SkillRoot } from '#/app/skillCatalog/types';

interface RecordedWarning {
  readonly message: string;
  readonly payload: LogPayload;
}

describe('FileSkillDiscovery', () => {
  let root: string;
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let warnings: RecordedWarning[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-store-'));
    warnings = [];
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(ILogService, {
          _serviceBrand: undefined,
          level: 'debug',
          setLevel: () => {},
          flush: async () => {},
          error: () => {},
          warn: (message: string, payload?: LogPayload) => {
            warnings.push({ message, payload });
          },
          info: () => {},
          debug: () => {},
          child: () => {
            throw new Error('child loggers are not used by FileSkillDiscovery');
          },
        } satisfies ILogService);
        reg.define(ISkillDiscovery, FileSkillDiscovery);
      },
    });
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(root, { recursive: true, force: true });
  });

  function discover(roots: readonly SkillRoot[]) {
    return ix.get(ISkillDiscovery).discover(roots);
  }

  async function writeSkill(rel: string, frontmatter: string, body = 'body'): Promise<void> {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, `---\n${frontmatter}\n---\n${body}`);
  }

  function skillRoot(rel: string, source: SkillRoot['source'] = 'project'): SkillRoot {
    return { path: join(root, rel), source };
  }

  function pluginSkillRoot(rel: string, pluginId: string): SkillRoot {
    return {
      path: join(root, rel),
      source: 'extra',
      plugin: { id: pluginId },
    };
  }

  it('discovers a directory skill under a root', async () => {
    await writeSkill('skills/commit/SKILL.md', 'name: commit\ndescription: commit changes');

    const result = await discover([skillRoot('skills')]);

    expect(result.skills.map((s) => s.name)).toEqual(['commit']);
    expect(result.skills[0]?.source).toBe('project');
  });

  it('returns an empty result when given no roots', async () => {
    const result = await discover([]);

    expect(result.skills).toEqual([]);
    expect(result.scannedRoots).toEqual([]);
  });

  it('discovers a flat .md skill at the root top level', async () => {
    await writeSkill('skills/summarize.md', 'name: summarize\ndescription: summarize text');

    const result = await discover([skillRoot('skills')]);

    expect(result.skills.map((s) => s.name)).toEqual(['summarize']);
  });

  it('lets the first root win over a later sibling root on name collision', async () => {
    await writeSkill('brand/dup/SKILL.md', 'name: dup\ndescription: from brand');
    await writeSkill('generic/dup/SKILL.md', 'name: dup\ndescription: from generic');

    const result = await discover([skillRoot('brand'), skillRoot('generic')]);

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.description).toBe('from brand');
  });

  it('dedupes same-named skills across roots from the same plugin', async () => {
    await writeSkill('plugin-a-first/dup/SKILL.md', 'name: DUP\ndescription: from first root');
    await writeSkill('plugin-a-second/dup/SKILL.md', 'name: dup\ndescription: from second root');

    const result = await discover([
      pluginSkillRoot('plugin-a-first', 'plugin-a'),
      pluginSkillRoot('plugin-a-second', 'plugin-a'),
    ]);

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toEqual(
      expect.objectContaining({
        name: 'DUP',
        description: 'from first root',
        plugin: { id: 'plugin-a' },
      }),
    );
  });

  it('preserves same-named skills from different plugins', async () => {
    await writeSkill('plugin-a/dup/SKILL.md', 'name: DUP\ndescription: from plugin A');
    await writeSkill('plugin-b/dup/SKILL.md', 'name: dup\ndescription: from plugin B');

    const result = await discover([
      pluginSkillRoot('plugin-a', 'plugin-a'),
      pluginSkillRoot('plugin-b', 'plugin-b'),
    ]);

    expect(result.skills).toHaveLength(2);
    expect(
      result.skills
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          pluginId: skill.plugin?.id,
        }))
        .toSorted((a, b) => (a.pluginId ?? '').localeCompare(b.pluginId ?? '')),
    ).toEqual([
      { name: 'DUP', description: 'from plugin A', pluginId: 'plugin-a' },
      { name: 'dup', description: 'from plugin B', pluginId: 'plugin-b' },
    ]);
  });

  it('discovers sub-skills of a parent that opts in', async () => {
    await writeSkill(
      'skills/parent/SKILL.md',
      'name: parent\ndescription: parent\nhas-sub-skill: true',
    );
    await writeSkill('skills/parent/child/SKILL.md', 'name: child\ndescription: child skill');

    const result = await discover([skillRoot('skills')]);
    const names = result.skills.map((s) => s.name).toSorted();

    expect(names).toEqual(['parent', 'parent.child']);
    expect(result.skills.find((s) => s.name === 'parent.child')?.metadata.isSubSkill).toBe(true);
  });

  it('does not discover nested SKILL.md files when the parent bundle does not opt in', async () => {
    await writeSkill('skills/parent/SKILL.md', 'name: parent\ndescription: parent');
    await writeSkill('skills/parent/child/SKILL.md', 'name: child\ndescription: child skill');

    const result = await discover([skillRoot('skills')]);

    expect(result.skills.map((s) => s.name)).toEqual(['parent']);
  });

  it('discovers nested SKILL.md files when has-sub-skill is nested under metadata', async () => {
    await writeSkill(
      'skills/outer/SKILL.md',
      'name: outer\ndescription: Parent skill\nmetadata:\n  has-sub-skill: true',
    );
    await writeSkill('skills/outer/child/SKILL.md', 'name: child\ndescription: child skill');

    const result = await discover([skillRoot('skills')]);
    const names = result.skills.map((s) => s.name).toSorted();

    expect(names).toEqual(['outer', 'outer.child']);
    expect(result.skills.find((s) => s.name === 'outer.child')?.metadata.isSubSkill).toBe(true);
  });

  it('ignores node_modules and dot directories while walking', async () => {
    await writeSkill(
      'skills/node_modules/hidden/SKILL.md',
      'name: hidden\ndescription: hidden',
    );

    const result = await discover([skillRoot('skills')]);

    expect(result.skills.map((s) => s.name)).not.toContain('hidden');
  });

  it('warns and skips a skill whose SKILL.md has invalid frontmatter', async () => {
    const skillMdPath = join(root, 'skills/broken/SKILL.md');
    await mkdir(dirname(skillMdPath), { recursive: true });
    await writeFile(skillMdPath, 'no frontmatter here');

    const result = await discover([skillRoot('skills')]);

    expect(result.skills).toEqual([]);
    expect(warnings).toEqual([
      {
        message: `Skipping invalid skill at ${skillMdPath}: Missing frontmatter in ${skillMdPath}`,
        payload: expect.any(Error),
      },
    ]);
  });

  it('records a skill with an unsupported type as skipped instead of warning', async () => {
    await writeSkill('skills/legacy/SKILL.md', 'name: legacy\ndescription: old\ntype: nope');

    const result = await discover([skillRoot('skills')]);

    expect(result.skills).toEqual([]);
    expect(result.skipped).toEqual([
      {
        path: join(root, 'skills/legacy/SKILL.md'),
        type: 'nope',
        reason: 'unsupported skill type "nope"',
      },
    ]);
    expect(warnings).toEqual([]);
  });
});
