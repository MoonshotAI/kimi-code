import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FLAG_DEFINITIONS, FlagResolver } from '../../src/flags';
import { discoverSkills, resolveSkillRoots, SkillRegistry, type SkillRoot } from '../../src/skill';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('skill discovery', () => {
  it('resolves documented roots in precedence order with brand merging enabled by default', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    await mkdir(path.join(repoDir, '.kimi-code', 'skills'), { recursive: true });
    await mkdir(path.join(repoDir, '.agents', 'skills'), { recursive: true });
    await mkdir(path.join(homeDir, '.kimi-code', 'skills'), { recursive: true });
    await mkdir(path.join(homeDir, '.agents', 'skills'), { recursive: true });
    await mkdir(path.join(repoDir, 'team-skills'), { recursive: true });
    const realRepoDir = await realpath(repoDir);

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      extraDirs: ['team-skills'],
    });

    expect(roots.map((root) => path.relative(realRepoDir, root.path))).toEqual([
      '.kimi-code/skills',
      '.agents/skills',
      path.relative(realRepoDir, await realpath(path.join(homeDir, '.kimi-code', 'skills'))),
      path.relative(realRepoDir, await realpath(path.join(homeDir, '.agents', 'skills'))),
      'team-skills',
    ]);
    expect(roots.map((root) => root.source)).toEqual([
      'project',
      'project',
      'user',
      'user',
      'extra',
    ]);
  });

  it('uses only the first brand directory when brand merging is disabled', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    await mkdir(path.join(repoDir, '.kimi-code', 'skills'), { recursive: true });
    await mkdir(path.join(homeDir, '.kimi-code', 'skills'), { recursive: true });

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      mergeAllAvailableSkills: false,
    });

    expect(roots.map((root) => root.path)).toEqual([
      await realpath(path.join(repoDir, '.kimi-code', 'skills')),
      await realpath(path.join(homeDir, '.kimi-code', 'skills')),
    ]);
  });

  it('lets explicit skill dirs replace automatic project and user discovery', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    await mkdir(path.join(repoDir, '.kimi-code', 'skills'), { recursive: true });
    await mkdir(path.join(homeDir, '.kimi-code', 'skills'), { recursive: true });
    await mkdir(path.join(repoDir, 'explicit-skills'), { recursive: true });
    await mkdir(path.join(repoDir, 'extra-skills'), { recursive: true });

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      explicitDirs: ['explicit-skills'],
      extraDirs: ['extra-skills'],
    });
    const realRepoDir = await realpath(repoDir);

    expect(roots.map((root) => [path.relative(realRepoDir, root.path), root.source])).toEqual([
      ['explicit-skills', 'user'],
      ['extra-skills', 'extra'],
    ]);
  });

  it('discovers flat markdown skills, keeps directory skills over same-name flat files, and preserves source precedence', async () => {
    const { homeDir, repoDir } = await makeWorkspace();
    const projectRoot = path.join(repoDir, '.kimi-code', 'skills');
    const userRoot = path.join(homeDir, '.kimi-code', 'skills');
    await writeSkill(projectRoot, 'review.md', ['Project review body first line.', '', 'Details.']);
    await writeSkill(userRoot, path.join('review', 'SKILL.md'), [
      '---',
      'name: review',
      'description: User review',
      '---',
      '',
      'User review body.',
    ]);
    await writeSkill(projectRoot, path.join('deploy', 'SKILL.md'), [
      '---',
      'name: deploy',
      'description: Directory deploy',
      '---',
      '',
      'Deploy body.',
    ]);
    await writeSkill(projectRoot, 'deploy.md', ['Flat deploy should be ignored.']);

    const warnings: string[] = [];
    const roots: SkillRoot[] = [
      { path: projectRoot, source: 'project' },
      { path: userRoot, source: 'user' },
    ];
    const skills = await discoverSkills({
      roots,
      onWarning: (message) => warnings.push(message),
    });

    expect(skills.map((skill) => [skill.name, skill.description, skill.source])).toEqual([
      ['deploy', 'Directory deploy', 'project'],
      ['review', 'Project review body first line.', 'project'],
    ]);
    expect(warnings.some((message) => message.includes('Ignoring flat skill'))).toBe(true);
  });

  it('keeps flow skills user-visible while excluding them from model invocation', async () => {
    const { repoDir } = await makeWorkspace();
    const projectRoot = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(projectRoot, path.join('review-flow', 'SKILL.md'), [
      '---',
      'name: review-flow',
      'description: Review flow',
      'type: flow',
      '---',
      '',
      '```mermaid',
      'flowchart TD',
      'BEGIN --> END',
      '```',
    ]);

    const registry = new SkillRegistry();
    await registry.loadRoots([{ path: projectRoot, source: 'project' }]);

    expect(registry.listSkills().map((skill) => skill.name)).toEqual(['review-flow']);
    expect(registry.listInvocableSkills()).toEqual([]);
  });

  it('skips directory skills with missing frontmatter metadata', async () => {
    const { repoDir } = await makeWorkspace();
    const projectRoot = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(projectRoot, path.join('valid', 'SKILL.md'), [
      '---',
      'name: valid',
      'description: Valid skill',
      '---',
      '',
      'Valid body.',
    ]);
    await writeSkill(projectRoot, path.join('no-frontmatter', 'SKILL.md'), [
      '# Heading should not become a description',
      '',
      'Body.',
    ]);
    await writeSkill(projectRoot, path.join('missing-name', 'SKILL.md'), [
      '---',
      'description: Missing name',
      '---',
      '',
      'Body.',
    ]);
    await writeSkill(projectRoot, path.join('missing-description', 'SKILL.md'), [
      '---',
      'name: missing-description',
      '---',
      '',
      '# Heading should not become a description',
    ]);

    const warnings: string[] = [];
    const skills = await discoverSkills({
      roots: [{ path: projectRoot, source: 'project' }],
      onWarning: (message) => warnings.push(message),
    });

    expect(skills.map((skill) => skill.name)).toEqual(['valid']);
    expect(warnings).toHaveLength(3);
    expect(warnings.some((message) => message.includes('Missing frontmatter'))).toBe(true);
    expect(warnings.some((message) => message.includes('"name"'))).toBe(true);
    expect(warnings.some((message) => message.includes('"description"'))).toBe(true);
  });
});

describe('discoverSkills shape and ordering', () => {
  it('parses frontmatter name/description for subdir skills', async () => {
    const { repoDir } = await makeWorkspace();
    const root = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(root, path.join('alpha', 'SKILL.md'), [
      '---',
      'name: alpha-skill',
      'description: Alpha description',
      '---',
    ]);

    const skills = await discoverSkills({ roots: [{ path: root, source: 'user' }] });

    expect(skills.map((skill) => [skill.name, skill.description, skill.source])).toEqual([
      ['alpha-skill', 'Alpha description', 'user'],
    ]);
  });

  it('keeps the first roots version when a skill name appears in multiple roots', async () => {
    const { repoDir } = await makeWorkspace();
    const rootA = path.join(repoDir, 'root_a');
    const rootB = path.join(repoDir, 'root_b');
    await writeSkill(rootA, path.join('greet', 'SKILL.md'), [
      '---',
      'name: greet',
      'description: A',
      '---',
      'Hello from A',
    ]);
    await writeSkill(rootB, path.join('greet', 'SKILL.md'), [
      '---',
      'name: greet',
      'description: B',
      '---',
      'Hello from B',
    ]);

    const skills = await discoverSkills({
      roots: [
        { path: rootA, source: 'builtin' },
        { path: rootB, source: 'user' },
      ],
    });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe('A');
  });

  it('does not register a top-level SKILL.md as a flat skill', async () => {
    const { repoDir } = await makeWorkspace();
    const root = path.join(repoDir, '.kimi-code', 'skills');
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, 'SKILL.md'),
      ['---', 'name: not-a-skill', 'description: accidental', '---'].join('\n'),
    );

    const skills = await discoverSkills({ roots: [{ path: root, source: 'user' }] });

    expect(skills).toEqual([]);
  });

  it('lists flat skills with frontmatter name and description', async () => {
    const { repoDir } = await makeWorkspace();
    const root = path.join(repoDir, '.kimi-code', 'skills');
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, 'demo-ui-components.md'),
      ['---', 'name: demo-ui-components', 'description: Demo UI', '---', 'Body'].join('\n'),
    );

    const skills = await discoverSkills({ roots: [{ path: root, source: 'user' }] });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('demo-ui-components');
    expect(skills[0]?.description).toBe('Demo UI');
  });

  it('discovers both flat and subdir skills alongside in the same root', async () => {
    const { repoDir } = await makeWorkspace();
    const root = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(root, path.join('subdir-skill', 'SKILL.md'), [
      '---',
      'name: subdir-skill',
      'description: From subdir',
      '---',
    ]);
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, 'flat-skill.md'),
      ['---', 'name: flat-skill', 'description: From flat', '---'].join('\n'),
    );

    const skills = await discoverSkills({ roots: [{ path: root, source: 'user' }] });
    expect(skills.map((s) => s.name).toSorted()).toEqual(['flat-skill', 'subdir-skill']);
  });

  it('prefers the subdir version when a flat and subdir skill share a name', async () => {
    const { repoDir } = await makeWorkspace();
    const root = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(root, path.join('greet', 'SKILL.md'), [
      '---',
      'name: greet',
      'description: From subdir',
      '---',
    ]);
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, 'greet.md'),
      ['---', 'name: greet', 'description: From flat', '---'].join('\n'),
    );

    const skills = await discoverSkills({ roots: [{ path: root, source: 'user' }] });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe('From subdir');
  });

  it('discovers skills nested in subdirectories at multiple depths', async () => {
    const { repoDir } = await makeWorkspace();
    const root = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(root, path.join('top', 'SKILL.md'), [
      '---',
      'name: top',
      'description: Top level',
      '---',
    ]);
    await writeSkill(root, path.join('group', 'alpha', 'SKILL.md'), [
      '---',
      'name: alpha',
      'description: One level deep',
      '---',
    ]);
    await writeSkill(root, path.join('a', 'b', 'beta', 'SKILL.md'), [
      '---',
      'name: beta',
      'description: Two levels deep',
      '---',
    ]);
    // A loose .md below the top level is skill payload, not a skill.
    await writeFile(path.join(root, 'group', 'notes.md'), 'just some notes');

    const skills = await discoverSkills({ roots: [{ path: root, source: 'user' }] });

    expect(skills.map((s) => s.name)).toEqual(['alpha', 'beta', 'top']);
  });

  it('discovers nested SKILL.md files inside a skill bundle when has-sub-skill is enabled', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_SUB_SKILL', '1');
    const { repoDir } = await makeWorkspace();
    const root = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(root, path.join('outer', 'SKILL.md'), [
      '---',
      'name: outer',
      'description: Parent skill',
      'has-sub-skill: true',
      '---',
      '',
      'Outer body.',
    ]);
    await writeSkill(root, path.join('outer', 'references', 'inner', 'SKILL.md'), [
      '---',
      'name: inner',
      'description: Nested skill',
      '---',
      '',
      'Inner body should stay private until activation.',
    ]);
    await writeFile(
      path.join(root, 'outer', 'references', 'notes.md'),
      'Nested payload should not be listed.',
    );

    const skills = await discoverSkills({ roots: [{ path: root, source: 'user' }] });

    expect(skills.map((s) => s.name)).toEqual(['inner', 'outer']);
  });

  it('discovers nested SKILL.md files when sub-skill is enabled by scoped config', async () => {
    const { repoDir } = await makeWorkspace();
    const root = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(root, path.join('outer', 'SKILL.md'), [
      '---',
      'name: outer',
      'description: Parent skill',
      'has-sub-skill: true',
      '---',
      '',
      'Outer body.',
    ]);
    await writeSkill(root, path.join('outer', 'references', 'inner', 'SKILL.md'), [
      '---',
      'name: inner',
      'description: Nested skill',
      '---',
      '',
      'Inner body.',
    ]);

    const skills = await discoverSkills({
      roots: [{ path: root, source: 'user' }],
      experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS, { 'sub_skill': true }),
    });

    expect(skills.map((s) => s.name)).toEqual(['inner', 'outer']);
  });

  it('does not discover nested SKILL.md files when the parent bundle disables sub-skills', async () => {
    const { repoDir } = await makeWorkspace();
    const root = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(root, path.join('outer', 'SKILL.md'), [
      '---',
      'name: outer',
      'description: Parent skill',
      '---',
      '',
      'Outer body.',
    ]);
    await writeSkill(root, path.join('outer', 'references', 'inner', 'SKILL.md'), [
      '---',
      'name: inner',
      'description: Nested skill',
      '---',
      '',
      'Inner body should stay private until activation.',
    ]);

    const skills = await discoverSkills({ roots: [{ path: root, source: 'user' }] });

    expect(skills.map((s) => s.name)).toEqual(['outer']);
  });

  it('discovers nested SKILL.md files when has-sub-skill is nested under metadata', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_SUB_SKILL', '1');
    const { repoDir } = await makeWorkspace();
    const root = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(root, path.join('outer', 'SKILL.md'), [
      '---',
      'name: outer',
      'description: Parent skill',
      'metadata:',
      '  has-sub-skill: true',
      '---',
      '',
      'Outer body.',
    ]);
    await writeSkill(root, path.join('outer', 'inner', 'SKILL.md'), [
      '---',
      'name: outer.inner',
      'description: Nested skill',
      '---',
      '',
      'Inner body.',
    ]);

    const skills = await discoverSkills({ roots: [{ path: root, source: 'user' }] });

    expect(skills.map((s) => s.name)).toEqual(['outer', 'outer.inner']);
  });

  it('treats sub-skill discovery as opt-in via the KIMI_CODE_EXPERIMENTAL_SUB_SKILL flag', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_SUB_SKILL', '0');
    const { repoDir } = await makeWorkspace();
    const root = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(root, path.join('outer', 'SKILL.md'), [
      '---',
      'name: outer',
      'description: Parent skill',
      'has-sub-skill: true',
      '---',
      '',
      'Outer body.',
    ]);
    await writeSkill(root, path.join('outer', 'inner', 'SKILL.md'), [
      '---',
      'name: outer.inner',
      'description: Nested skill',
      '---',
      '',
      'Inner body.',
    ]);

    const skills = await discoverSkills({ roots: [{ path: root, source: 'user' }] });

    expect(skills.map((s) => s.name)).toEqual(['outer']);
  });

  it('skips node_modules when scanning nested directories', async () => {
    const { repoDir } = await makeWorkspace();
    const root = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(root, path.join('real', 'SKILL.md'), [
      '---',
      'name: real',
      'description: A real skill',
      '---',
    ]);
    await writeSkill(root, path.join('node_modules', 'pkg', 'vendored', 'SKILL.md'), [
      '---',
      'name: vendored',
      'description: Should never load',
      '---',
    ]);

    const skills = await discoverSkills({ roots: [{ path: root, source: 'user' }] });

    expect(skills.map((s) => s.name)).toEqual(['real']);
  });

  it('stops recursing past the maximum scan depth', async () => {
    const { repoDir } = await makeWorkspace();
    const root = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(root, path.join('shallow', 'SKILL.md'), [
      '---',
      'name: shallow',
      'description: Near the root',
      '---',
    ]);
    const deepSegments = Array.from({ length: 11 }, (_, i) => `lvl-${i}`);
    await writeSkill(root, path.join(...deepSegments, 'deep', 'SKILL.md'), [
      '---',
      'name: deep',
      'description: Far below the depth cap',
      '---',
    ]);

    const skills = await discoverSkills({ roots: [{ path: root, source: 'user' }] });

    expect(skills.map((s) => s.name)).toEqual(['shallow']);
  });

  it('prefers a shallower skill over a deeper one with the same name', async () => {
    const { repoDir } = await makeWorkspace();
    const root = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(root, path.join('dup', 'SKILL.md'), [
      '---',
      'name: dup',
      'description: Shallow wins',
      '---',
    ]);
    await writeSkill(root, path.join('group', 'dup', 'SKILL.md'), [
      '---',
      'name: dup',
      'description: Deep loses',
      '---',
    ]);

    const skills = await discoverSkills({ roots: [{ path: root, source: 'user' }] });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe('Shallow wins');
  });

  it('resolves a same-name collision across sibling directories deterministically', async () => {
    const { repoDir } = await makeWorkspace();
    const root = path.join(repoDir, '.kimi-code', 'skills');
    // Created out of alphabetical order so the result cannot depend on
    // filesystem readdir order; the alphabetically-first sibling must win.
    await writeSkill(root, path.join('group-b', 'dup', 'SKILL.md'), [
      '---',
      'name: dup',
      'description: From group-b',
      '---',
    ]);
    await writeSkill(root, path.join('group-a', 'dup', 'SKILL.md'), [
      '---',
      'name: dup',
      'description: From group-a',
      '---',
    ]);

    const skills = await discoverSkills({ roots: [{ path: root, source: 'user' }] });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe('From group-a');
  });

  it('returns an empty list when the skill root cannot be read', async () => {
    const { repoDir } = await makeWorkspace();
    const root = path.join(repoDir, 'locked');
    await mkdir(root, { recursive: true });

    const skills = await discoverSkills({
      roots: [{ path: root, source: 'extra' }],
      readdir: async () => {
        throw Object.assign(new Error('simulated'), { code: 'EACCES' });
      },
    });

    expect(skills).toEqual([]);
  });
});

describe('resolveSkillRoots ordering and priority', () => {
  it('returns project then user then builtin in priority order', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const userGeneric = path.join(homeDir, '.agents', 'skills');
    await mkdir(userGeneric, { recursive: true });
    const projectGeneric = path.join(repoDir, '.agents', 'skills');
    await mkdir(projectGeneric, { recursive: true });
    const builtin = path.join(repoDir, 'builtin');
    await mkdir(builtin, { recursive: true });

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      builtinDir: builtin,
    });

    expect(roots.map((root) => root.source)).toEqual(['project', 'user', 'builtin']);
  });

  it('treats empty explicit dirs identically to omitting them', async () => {
    const { homeDir, workDir } = await makeWorkspace();

    const omitted = await resolveSkillRoots({ paths: { userHomeDir: homeDir, workDir } });
    const empty = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      explicitDirs: [],
    });

    expect(empty).toEqual(omitted);
  });

  it('returns no user roots when no skill dirs exist in the home directory', async () => {
    const { homeDir, workDir } = await makeWorkspace();

    const roots = await resolveSkillRoots({ paths: { userHomeDir: homeDir, workDir } });

    expect(roots.filter((r) => r.source === 'user')).toEqual([]);
  });

  it('prefers brand over generic user dirs even when both contain skills with the same name', async () => {
    const { homeDir, workDir } = await makeWorkspace();
    const generic = path.join(homeDir, '.agents', 'skills');
    await writeSkill(generic, path.join('greet', 'SKILL.md'), [
      '---',
      'name: greet',
      'description: generic version',
      '---',
    ]);
    const brand = path.join(homeDir, '.kimi-code', 'skills');
    await writeSkill(brand, path.join('greet', 'SKILL.md'), [
      '---',
      'name: greet',
      'description: brand version',
      '---',
    ]);

    const roots = await resolveSkillRoots({ paths: { userHomeDir: homeDir, workDir } });
    const skills = await discoverSkills({ roots });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe('brand version');
  });

  it('returns proj-brand, proj-generic, user-brand, user-generic, builtin in that order without merging', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const userBrand = path.join(homeDir, '.kimi-code', 'skills');
    const userGeneric = path.join(homeDir, '.agents', 'skills');
    const projBrand = path.join(repoDir, '.kimi-code', 'skills');
    const projGeneric = path.join(repoDir, '.agents', 'skills');
    const builtin = path.join(repoDir, 'builtin');
    for (const d of [userBrand, userGeneric, projBrand, projGeneric, builtin]) {
      await mkdir(d, { recursive: true });
    }

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      builtinDir: builtin,
      mergeAllAvailableSkills: false,
    });

    expect(roots.map((r) => r.path)).toEqual([
      await realpath(projBrand),
      await realpath(projGeneric),
      await realpath(userBrand),
      await realpath(userGeneric),
      await realpath(builtin),
    ]);
  });

  it('keeps brand user skills visible when the generic group is empty', async () => {
    const { homeDir, workDir } = await makeWorkspace();
    const generic = path.join(homeDir, '.config', 'agents', 'skills');
    await mkdir(generic, { recursive: true });
    const brand = path.join(homeDir, '.kimi-code', 'skills');
    await writeSkill(brand, path.join('deploy', 'SKILL.md'), [
      '---',
      'name: deploy',
      'description: Deploy to prod',
      '---',
    ]);

    const roots = await resolveSkillRoots({ paths: { userHomeDir: homeDir, workDir } });
    const skills = await discoverSkills({ roots });

    expect(skills.map((s) => s.name)).toContain('deploy');
  });

  it('defaults to merging user brand dirs', async () => {
    const { homeDir, workDir } = await makeWorkspace();
    await mkdir(path.join(homeDir, '.kimi-code', 'skills'), { recursive: true });

    const roots = await resolveSkillRoots({ paths: { userHomeDir: homeDir, workDir } });

    const paths = roots.map((r) => r.path);
    expect(paths).toContain(await realpath(path.join(homeDir, '.kimi-code', 'skills')));
  });
});

describe('resolveSkillRoots extra dirs', () => {
  it('appends extra dirs to the resolved roots', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const extra = path.join(repoDir, 'my-extra');
    await mkdir(extra, { recursive: true });

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      extraDirs: [extra],
    });

    expect(roots.map((r) => r.path)).toContain(await realpath(extra));
  });

  it('expands a leading ~/ in extra dirs against the user home directory', async () => {
    const { homeDir, workDir } = await makeWorkspace();
    const target = path.join(homeDir, 'my-skills');
    await mkdir(target, { recursive: true });

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      extraDirs: ['~/my-skills'],
    });

    expect(roots.map((r) => r.path)).toContain(await realpath(target));
  });

  it('resolves a relative extra dir against the project root (.git ancestor), not the work dir', async () => {
    const { homeDir, repoDir } = await makeWorkspace();
    const nested = path.join(repoDir, 'sub', 'dir');
    await mkdir(nested, { recursive: true });
    const extraAtRoot = path.join(repoDir, 'my-dir');
    await mkdir(extraAtRoot, { recursive: true });

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir: nested },
      extraDirs: ['my-dir'],
    });

    const paths = roots.map((r) => r.path);
    expect(paths).toContain(await realpath(extraAtRoot));
    expect(paths).not.toContain(path.join(nested, 'my-dir'));
  });

  it('uses absolute extra-dir paths as-is', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const absExtra = path.join(repoDir, '..', 'somewhere-else');
    await mkdir(absExtra, { recursive: true });

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      extraDirs: [absExtra],
    });

    expect(roots.map((r) => r.path)).toContain(await realpath(absExtra));
  });

  it('silently drops missing extra-dir entries', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const real = path.join(repoDir, 'real');
    await mkdir(real, { recursive: true });

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      extraDirs: [real, path.join(repoDir, 'nowhere'), path.join(repoDir, 'nope')],
    });

    const paths = roots.map((r) => r.path);
    expect(paths).toContain(await realpath(real));
    expect(paths).not.toContain(path.join(repoDir, 'nowhere'));
  });

  it('deduplicates duplicate entries in extra dirs', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const real = path.join(repoDir, 'real');
    await mkdir(real, { recursive: true });

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      extraDirs: [real, real],
    });

    const realResolved = await realpath(real);
    const matches = roots.filter((r) => r.path === realResolved);
    expect(matches).toHaveLength(1);
  });

  it('preserves plugin metadata when a plugin skill root duplicates an extra dir', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const real = path.join(repoDir, 'real');
    await mkdir(real, { recursive: true });

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      extraDirs: [real],
      pluginSkillRoots: [
        {
          path: real,
          source: 'extra',
          plugin: {
            id: 'superpowers',
            instructions: 'Use AskUserQuestion.',
          },
        },
      ],
    });

    const realResolved = await realpath(real);
    const matches = roots.filter((r) => r.path === realResolved);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.plugin).toEqual({
      id: 'superpowers',
      instructions: 'Use AskUserQuestion.',
    });
  });

  it('keeps plugin-specific skill lookup when a project skill has the same name', async () => {
    const { repoDir } = await makeWorkspace();
    const projectRoot = path.join(repoDir, '.kimi-code', 'skills');
    const pluginRoot = path.join(repoDir, 'plugin-skills');
    await writeSkill(projectRoot, path.join('using-superpowers', 'SKILL.md'), [
      '---',
      'name: using-superpowers',
      'description: Project override',
      '---',
      '',
      'project body',
    ]);
    await writeSkill(pluginRoot, path.join('using-superpowers', 'SKILL.md'), [
      '---',
      'name: using-superpowers',
      'description: Plugin startup',
      '---',
      '',
      'plugin body',
    ]);
    const registry = new SkillRegistry();

    await registry.loadRoots([
      { path: projectRoot, source: 'project' },
      {
        path: pluginRoot,
        source: 'extra',
        plugin: { id: 'superpowers' },
      },
    ]);

    expect(registry.getSkill('using-superpowers')?.content).toBe('project body');
    expect(registry.getPluginSkill('superpowers', 'using-superpowers')?.content).toBe(
      'plugin body',
    );
  });

  it('stamps skills discovered via extra dirs with source=extra', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const extra = path.join(repoDir, 'my-extra');
    await writeSkill(extra, path.join('xs', 'SKILL.md'), [
      '---',
      'name: xs',
      'description: x',
      '---',
    ]);

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      extraDirs: [extra],
    });
    const skills = await discoverSkills({ roots });
    const xs = skills.find((s) => s.name === 'xs');

    expect(xs?.source).toBe('extra');
  });

  it('combines explicit dirs with extra dirs and suppresses auto-discovery', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const userBrand = path.join(homeDir, '.kimi-code', 'skills');
    await mkdir(userBrand, { recursive: true });
    const projectBrand = path.join(repoDir, '.kimi-code', 'skills');
    await mkdir(projectBrand, { recursive: true });
    const cli = path.join(repoDir, 'cli');
    await mkdir(cli, { recursive: true });
    const extra = path.join(repoDir, 'extra');
    await mkdir(extra, { recursive: true });

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      explicitDirs: [cli],
      extraDirs: [extra],
    });

    const paths = roots.map((r) => r.path);
    expect(paths).toContain(await realpath(cli));
    expect(paths).toContain(await realpath(extra));
    expect(paths).not.toContain(await realpath(userBrand));
    expect(paths).not.toContain(await realpath(projectBrand));
  });

  it('collapses a real dir and a symlink to the same target into one root', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const real = path.join(repoDir, 'real');
    await mkdir(real, { recursive: true });
    const link = path.join(repoDir, 'link');
    await symlink(real, link);

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      extraDirs: [real, link],
    });

    const extras = roots.filter((r) => r.source === 'extra');
    expect(extras).toHaveLength(1);
    expect(extras[0]?.path).toBe(await realpath(real));
  });

  it('collapses entries differing only by trailing slash', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const real = path.join(repoDir, 'real');
    await mkdir(real, { recursive: true });

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      extraDirs: [real, `${real}/`],
    });

    const extras = roots.filter((r) => r.source === 'extra');
    expect(extras).toHaveLength(1);
  });

  it('preserves source=extra on the surviving root after symlink dedup', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const real = path.join(repoDir, 'real');
    await mkdir(real, { recursive: true });
    const link = path.join(repoDir, 'link');
    await symlink(real, link);

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      extraDirs: [real, link],
    });

    const extras = roots.filter((r) => r.source === 'extra');
    expect(extras).toHaveLength(1);
    expect(extras[0]?.source).toBe('extra');
  });

  it('stores the real path, not the symlink path, for a symlinked extra dir', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const real = path.join(repoDir, 'real');
    await mkdir(real, { recursive: true });
    const link = path.join(repoDir, 'link');
    await symlink(real, link);

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      extraDirs: [link],
    });

    const extras = roots.filter((r) => r.source === 'extra');
    expect(extras).toHaveLength(1);
    expect(extras[0]?.path).toBe(await realpath(real));
    expect(extras[0]?.path).not.toBe(link);
  });

  it('keeps the higher-priority scope when an extra dir overlaps with auto-discovered user dirs', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const userBrand = path.join(homeDir, '.kimi-code', 'skills');
    await writeSkill(userBrand, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: user version',
      '---',
    ]);
    await mkdir(path.join(repoDir, '.git'), { recursive: true });

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      extraDirs: [userBrand],
    });

    const realUserBrand = await realpath(userBrand);
    const matching = roots.filter((r) => r.path === realUserBrand);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.source).toBe('user');
  });
});

describe('scope priority across resolution and discovery', () => {
  it('lets a user-scope skill win over a same-named builtin', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const builtin = path.join(repoDir, 'builtin');
    await writeSkill(builtin, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: builtin version',
      '---',
    ]);
    const userBrand = path.join(homeDir, '.kimi-code', 'skills');
    await writeSkill(userBrand, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: user version',
      '---',
    ]);

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      builtinDir: builtin,
    });
    const skills = await discoverSkills({ roots });
    const foo = skills.find((s) => s.name === 'foo');

    expect(foo?.source).toBe('user');
    expect(foo?.description).toBe('user version');
  });

  it('lets a project-scope skill win over a same-named user-scope skill', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const userBrand = path.join(homeDir, '.kimi-code', 'skills');
    await writeSkill(userBrand, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: user version',
      '---',
    ]);
    const projBrand = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(projBrand, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: project version',
      '---',
    ]);

    const roots = await resolveSkillRoots({ paths: { userHomeDir: homeDir, workDir } });
    const skills = await discoverSkills({ roots });
    const foo = skills.find((s) => s.name === 'foo');

    expect(foo?.source).toBe('project');
    expect(foo?.description).toBe('project version');
  });

  it('lets a project-scope skill win over a same-named builtin', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const builtin = path.join(repoDir, 'builtin');
    await writeSkill(builtin, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: builtin version',
      '---',
    ]);
    const projBrand = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(projBrand, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: project version',
      '---',
    ]);

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      builtinDir: builtin,
    });
    const skills = await discoverSkills({ roots });
    const foo = skills.find((s) => s.name === 'foo');

    expect(foo?.source).toBe('project');
    expect(foo?.description).toBe('project version');
  });

  it('lets an extra-scope skill win over a same-named builtin', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const builtin = path.join(repoDir, 'builtin');
    await writeSkill(builtin, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: builtin version',
      '---',
    ]);
    const extra = path.join(repoDir, 'extra');
    await writeSkill(extra, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: extra version',
      '---',
    ]);

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      builtinDir: builtin,
      extraDirs: [extra],
    });
    const skills = await discoverSkills({ roots });
    const foo = skills.find((s) => s.name === 'foo');

    expect(foo?.source).toBe('extra');
    expect(foo?.description).toBe('extra version');
  });

  it('lets a user-scope skill win over a same-named extra-scope skill', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const userBrand = path.join(homeDir, '.kimi-code', 'skills');
    await writeSkill(userBrand, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: user version',
      '---',
    ]);
    const extra = path.join(repoDir, 'extra');
    await writeSkill(extra, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: extra version',
      '---',
    ]);

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      extraDirs: [extra],
    });
    const skills = await discoverSkills({ roots });
    const foo = skills.find((s) => s.name === 'foo');

    expect(foo?.source).toBe('user');
    expect(foo?.description).toBe('user version');
  });

  it('fully excludes user and project scopes when explicit dirs are supplied', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const userBrand = path.join(homeDir, '.kimi-code', 'skills');
    await writeSkill(userBrand, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: user version',
      '---',
    ]);
    const projBrand = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(projBrand, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: project version',
      '---',
    ]);
    const cli = path.join(repoDir, 'cli');
    await writeSkill(cli, path.join('bar', 'SKILL.md'), [
      '---',
      'name: bar',
      'description: cli version',
      '---',
    ]);

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      explicitDirs: [cli],
    });
    const skills = await discoverSkills({ roots });
    const names = new Set(skills.map((s) => s.name));

    expect(names.has('bar')).toBe(true);
    expect(names.has('foo')).toBe(false);
  });

  it('resolves a three-scope (builtin/user/project) conflict to a single project entry', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const builtin = path.join(repoDir, 'builtin');
    await writeSkill(builtin, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: builtin version',
      '---',
    ]);
    const userBrand = path.join(homeDir, '.kimi-code', 'skills');
    await writeSkill(userBrand, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: user version',
      '---',
    ]);
    const projBrand = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(projBrand, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: project version',
      '---',
    ]);

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      builtinDir: builtin,
    });
    const skills = await discoverSkills({ roots });
    const foos = skills.filter((s) => s.name === 'foo');

    expect(foos).toHaveLength(1);
    expect(foos[0]?.source).toBe('project');
    expect(foos[0]?.description).toBe('project version');
  });

  it('lets explicit (CLI) skills win over extra skills with the same name', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const cli = path.join(repoDir, 'cli');
    await writeSkill(cli, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: cli version',
      '---',
    ]);
    const extra = path.join(repoDir, 'extra');
    await writeSkill(extra, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: extra version',
      '---',
    ]);

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      explicitDirs: [cli],
      extraDirs: [extra],
    });
    const skills = await discoverSkills({ roots });
    const foos = skills.filter((s) => s.name === 'foo');

    expect(foos).toHaveLength(1);
    expect(foos[0]?.description).toBe('cli version');
  });
});

describe('explicit dir override and scope stamping', () => {
  it('suppresses user and project auto-discovery when explicit dirs are present', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const userBrand = path.join(homeDir, '.kimi-code', 'skills');
    await mkdir(userBrand, { recursive: true });
    const projBrand = path.join(repoDir, '.kimi-code', 'skills');
    await mkdir(projBrand, { recursive: true });
    const extraA = path.join(repoDir, 'extra_a');
    const extraB = path.join(repoDir, 'extra_b');
    await mkdir(extraA, { recursive: true });
    await mkdir(extraB, { recursive: true });
    const builtin = path.join(repoDir, 'builtin');
    await mkdir(builtin, { recursive: true });

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
      builtinDir: builtin,
      explicitDirs: [extraA, extraB],
    });

    const paths = roots.map((r) => r.path);
    expect(paths).toContain(await realpath(extraA));
    expect(paths).toContain(await realpath(extraB));
    expect(paths).toContain(await realpath(builtin));
    expect(paths).not.toContain(await realpath(userBrand));
    expect(paths).not.toContain(await realpath(projBrand));
  });

  it('returns both brand and generic user dirs when generic is empty (no shadowing)', async () => {
    const { homeDir, workDir } = await makeWorkspace();
    const generic = path.join(homeDir, '.agents', 'skills');
    await mkdir(generic, { recursive: true });
    const brand = path.join(homeDir, '.kimi-code', 'skills');
    await mkdir(brand, { recursive: true });

    const roots = await resolveSkillRoots({ paths: { userHomeDir: homeDir, workDir } });
    const userPaths = roots.filter((r) => r.source === 'user').map((r) => r.path);

    expect(userPaths).toContain(await realpath(brand));
    expect(userPaths).toContain(await realpath(generic));
    expect(userPaths.indexOf(await realpath(brand))).toBeLessThan(
      userPaths.indexOf(await realpath(generic)),
    );
  });

  it('stamps each discovered skill with the scope of its root', async () => {
    const { homeDir, repoDir, workDir } = await makeWorkspace();
    const userBrand = path.join(homeDir, '.kimi-code', 'skills');
    await writeSkill(userBrand, path.join('user-skill', 'SKILL.md'), [
      '---',
      'name: user-skill',
      'description: u',
      '---',
    ]);
    const projBrand = path.join(repoDir, '.kimi-code', 'skills');
    await writeSkill(projBrand, path.join('proj-skill', 'SKILL.md'), [
      '---',
      'name: proj-skill',
      'description: p',
      '---',
    ]);

    const roots = await resolveSkillRoots({ paths: { userHomeDir: homeDir, workDir } });
    const skills = await discoverSkills({ roots });
    const byName = new Map(skills.map((s) => [s.name, s] as const));

    expect(byName.get('user-skill')?.source).toBe('user');
    expect(byName.get('proj-skill')?.source).toBe('project');
  });
});

async function makeWorkspace(): Promise<{
  readonly homeDir: string;
  readonly repoDir: string;
  readonly workDir: string;
}> {
  const tmp = await mkdtemp(path.join(tmpdir(), 'kimi-skill-scanner-'));
  tempDirs.push(tmp);
  const homeDir = path.join(tmp, 'home');
  const repoDir = path.join(tmp, 'repo');
  const workDir = path.join(repoDir, 'packages', 'app');
  await mkdir(path.join(repoDir, '.git'), { recursive: true });
  await mkdir(workDir, { recursive: true });
  return { homeDir, repoDir, workDir };
}

describe('project root discovery (.git walk-up)', () => {
  it('walks up to the nearest .git ancestor for project-scope discovery', async () => {
    const { homeDir } = await makeWorkspace();
    const repo = await mkdtemp(path.join(tmpdir(), 'kimi-skill-walkup-'));
    tempDirs.push(repo);
    await mkdir(path.join(repo, '.git'), { recursive: true });
    const repoKimi = path.join(repo, '.kimi-code', 'skills');
    await writeSkill(repoKimi, path.join('foo', 'SKILL.md'), [
      '---',
      'name: foo',
      'description: repo-root foo',
      '---',
    ]);
    const nested = path.join(repo, 'packages', 'sub', 'pkg');
    await mkdir(nested, { recursive: true });

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir: nested },
    });
    const projectPaths = roots.filter((r) => r.source === 'project').map((r) => r.path);

    expect(projectPaths).toContain(await realpath(repoKimi));
  });

  it('falls back to the work dir when no .git marker is found anywhere up the chain', async () => {
    const { homeDir } = await makeWorkspace();
    const noGitTmp = await mkdtemp(path.join(tmpdir(), 'kimi-skill-nogit-'));
    tempDirs.push(noGitTmp);
    const project = path.join(noGitTmp, 'project');
    await mkdir(path.join(project, '.kimi-code', 'skills'), { recursive: true });
    const workDir = path.join(project, 'foo');
    await mkdir(workDir, { recursive: true });

    const roots = await resolveSkillRoots({
      paths: { userHomeDir: homeDir, workDir },
    });
    const projectPaths = roots.filter((r) => r.source === 'project').map((r) => r.path);

    expect(projectPaths.some((p) => p.includes(path.join('project', '.kimi-code', 'skills')))).toBe(false);
  });
});

async function writeSkill(
  root: string,
  relativePath: string,
  lines: readonly string[],
): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, lines.join('\n'));
}
