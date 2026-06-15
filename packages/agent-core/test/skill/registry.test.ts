import { describe, expect, it } from 'vitest';

import { SessionSkillRegistry } from '../../src/skill';
import type { SkillDefinition, SkillSource } from '../../src/skill';

describe('skill registry prompt rendering', () => {
  it('groups skills by scope under canonical section headings', () => {
    const registry = makeRegistry([
      makeSkill('builtin-a', 'builtin'),
      makeSkill('user-a', 'user'),
      makeSkill('proj-a', 'project'),
      makeSkill('extra-a', 'extra'),
    ]);

    const rendered = registry.getKimiSkillsDescription();

    expect(rendered).toContain('### Project');
    expect(rendered).toContain('### User');
    expect(rendered).toContain('### Extra');
    expect(rendered).toContain('### Built-in');

    const projectIdx = rendered.indexOf('### Project');
    const userIdx = rendered.indexOf('### User');
    const extraIdx = rendered.indexOf('### Extra');
    const builtinIdx = rendered.indexOf('### Built-in');
    expect(projectIdx).toBeLessThan(userIdx);
    expect(userIdx).toBeLessThan(extraIdx);
    expect(extraIdx).toBeLessThan(builtinIdx);

    expect(sectionFor(rendered, '### Project')).toContain('proj-a');
    expect(sectionFor(rendered, '### User')).toContain('user-a');
    expect(sectionFor(rendered, '### Extra')).toContain('extra-a');
    expect(sectionFor(rendered, '### Built-in')).toContain('builtin-a');
    expect(sectionFor(rendered, '### Project')).not.toContain('user-a');
    expect(sectionFor(rendered, '### User')).not.toContain('proj-a');
  });

  it('omits scope headings that have no skills', () => {
    const registry = makeRegistry([makeSkill('alpha', 'user')]);

    const rendered = registry.getKimiSkillsDescription();

    expect(rendered).toContain('### User');
    expect(rendered).not.toContain('### Project');
    expect(rendered).not.toContain('### Extra');
    expect(rendered).not.toContain('### Built-in');
  });

  it('renders a "No skills" placeholder for an empty registry', () => {
    const registry = new SessionSkillRegistry();

    const rendered = registry.getKimiSkillsDescription();

    expect(rendered.trim()).not.toBe('');
    expect(/no skills/i.test(rendered)).toBe(true);
  });

  it('sorts skills alphabetically within a scope', () => {
    const registry = makeRegistry([
      makeSkill('zebra', 'user'),
      makeSkill('alpha', 'user'),
      makeSkill('mango', 'user'),
    ]);

    const rendered = registry.getKimiSkillsDescription();

    const a = rendered.indexOf('alpha');
    const m = rendered.indexOf('mango');
    const z = rendered.indexOf('zebra');
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(m);
    expect(m).toBeLessThan(z);
  });

  it('end-to-end: a project skill that shadows other scopes renders once under Project', () => {
    const registry = makeRegistry([makeSkill('foo', 'project', 'project version', '/tmp/proj/foo/SKILL.md')]);

    const rendered = registry.getKimiSkillsDescription();

    expect(rendered.match(/\n- foo\n/g) ?? []).toHaveLength(1);
    expect(sectionFor(rendered, '### Project')).toContain('foo');
    expect(rendered).toContain('/tmp/proj/foo/SKILL.md');
    expect(rendered).toContain('project version');
  });

  it('renders each skill as name + Path + Description', () => {
    const registry = makeRegistry([
      makeSkill('alpha', 'user', 'Alpha does things', '/tmp/user/alpha/SKILL.md'),
    ]);

    const rendered = registry.getKimiSkillsDescription();

    expect(rendered).toContain('- alpha');
    expect(rendered).toContain('  - Path: /tmp/user/alpha/SKILL.md');
    expect(rendered).toContain('  - Description: Alpha does things');
  });
});

function makeRegistry(skills: readonly SkillDefinition[]): SessionSkillRegistry {
  const registry = new SessionSkillRegistry();

describe('skill registry search', () => {
  it('searchSkills returns relevant results by name and description', () => {
    const registry = makeRegistry([
      makeSkill('playwright-e2e', 'user', 'End-to-end testing with Playwright browser automation'),
      makeSkill('docker-expert', 'user', 'Docker containerization and deployment'),
      makeSkill('react-ui', 'user', 'React component patterns and hooks'),
    ]);

    const results = registry.searchSkills('playwright browser test');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.name).toBe('playwright-e2e');
  });

  it('searchSkills finds by synonym expansion', () => {
    const registry = makeRegistry([
      makeSkill('container-build', 'user', 'Docker container build optimization'),
      makeSkill('api-design', 'user', 'REST API design patterns'),
    ]);

    // "container" is a synonym of "docker"
    const results = registry.searchSkills('container image build');
    expect(results.some((r) => r.name === 'container-build')).toBe(true);
  });

  it('searchSkills returns empty for nonsense queries', () => {
    const registry = makeRegistry([makeSkill('alpha', 'user', 'does things')]);
    const results = registry.searchSkills('xyzzy plugh foobar');
    expect(results.length).toBe(0);
  });

  it('searchSkills lazily rebuilds index after register()', () => {
    const registry = new SkillRegistry();
    registry.register(makeSkill('initial-skill', 'user', 'initial'));

    const before = registry.searchSkills('initial');
    expect(before.length).toBe(1);

    registry.register(makeSkill('added-later', 'user', 'added after first search'));

    const after = registry.searchSkills('added');
    expect(after.length).toBe(1);
    expect(after[0]!.name).toBe('added-later');
  });

  it('searchSkills ranks name matches above description-only matches', () => {
    const registry = makeRegistry([
      makeSkill('playwright-e2e', 'user', 'End-to-end testing toolkit'),
      makeSkill('generic-browser', 'user', 'Browser automation with Playwright and Selenium'),
    ]);

    const results = registry.searchSkills('playwright');
    expect(results[0]!.name).toBe('playwright-e2e');
  });

  it('searchSkills expands synonyms bidirectionally', () => {
    const registry = makeRegistry([
      makeSkill('container-build', 'user', 'Docker container build optimization'),
      makeSkill('api-design', 'user', 'REST API design patterns'),
    ]);

    // "docker" is a synonym of "container", and the reverse mapping is now automatic.
    const results = registry.searchSkills('docker image build');
    expect(results.some((r) => r.name === 'container-build')).toBe(true);
  });

  it('searchSkills ignores stopwords in the query', () => {
    const registry = makeRegistry([
      makeSkill('docker-expert', 'user', 'Docker containerization and deployment'),
      makeSkill('react-ui', 'user', 'React component patterns and hooks'),
    ]);

    const results = registry.searchSkills('the docker container');
    expect(results[0]!.name).toBe('docker-expert');
  });

  it('getModelSkillListing caches the result and invalidates on register()', () => {
    const skills = Array.from({ length: 100 }, (_, i) =>
      makeSkill(`skill-${String(i)}`, 'user', `Description ${String(i)}`),
    );
    const registry = makeRegistry(skills);

    const first = registry.getModelSkillListing();
    const second = registry.getModelSkillListing();
    expect(second).toBe(first);

    registry.register(makeSkill('new-skill', 'user', 'A newly added skill'));
    const after = registry.getModelSkillListing();
    expect(after).not.toBe(first);
    expect(after).toContain('101 registered skills');
  });
});

describe('getModelSkillListing tiers', () => {
  it('uses legacy full listing for ≤80 skills (auto-detect)', () => {
    const skills = Array.from({ length: 50 }, (_, i) =>
      makeSkill(`skill-${String(i)}`, 'user', `Description ${String(i)}`),
    );
    const registry = makeRegistry(skills);

    const listing = registry.getModelSkillListing();
    expect(listing).toContain('DISREGARD');
    expect(listing).toContain('Description');
  });

  it('uses compact listing for 81–300 skills (auto-detect)', () => {
    const skills = Array.from({ length: 100 }, (_, i) =>
      makeSkill(`skill-${String(i)}`, 'user', `Description ${String(i)}`),
    );
    const registry = makeRegistry(skills);

    const listing = registry.getModelSkillListing();
    expect(listing).toContain('100 registered skills');
    expect(listing).toContain('search');
    expect(listing).not.toContain('DISREGARD');
    expect(listing).not.toContain('SKILL.md');
  });

  it('uses names-only listing for 300+ skills (auto-detect)', () => {
    const skills = Array.from({ length: 400 }, (_, i) =>
      makeSkill(`skill-${String(i)}`, 'user', `Description for skill ${String(i)}`),
    );
    const registry = makeRegistry(skills);

    const listing = registry.getModelSkillListing();
    expect(listing).toContain('400 registered skills');
    expect(listing).not.toContain('Description for skill');
    expect(listing).toContain('skill-0');
  });
});

function makeRegistry(skills: readonly SkillDefinition[]): SkillRegistry {
  const registry = new SkillRegistry();
  for (const skill of skills) registry.register(skill);
  return registry;
}

function makeSkill(
  name: string,
  source: SkillSource,
  description = 'desc',
  skillPath?: string,
): SkillDefinition {
  const finalPath = skillPath ?? `/tmp/${source}/${name}/SKILL.md`;
  return {
    name,
    description,
    path: finalPath,
    dir: finalPath.replace(/\/SKILL\.md$/, ''),
    content: '',
    metadata: { type: 'prompt' },
    source,
  };
}

function sectionFor(rendered: string, header: string): string {
  const start = rendered.indexOf(header);
  if (start === -1) return '';
  const next = rendered.indexOf('### ', start + header.length);
  return next === -1 ? rendered.slice(start) : rendered.slice(start, next);
}
