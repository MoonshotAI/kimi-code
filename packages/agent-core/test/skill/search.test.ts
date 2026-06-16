import { describe, expect, it } from 'vitest';
import { SkillSearchIndex } from '../../src/skill/search';

function makeSkill(name: string, description: string, whenToUse = '') {
  return {
    name,
    description,
    path: `/tmp/${name}/SKILL.md`,
    dir: `/tmp/${name}`,
    content: '',
    metadata: { type: 'prompt', whenToUse },
    source: 'user' as const,
  };
}

describe('SkillSearchIndex tokenization', () => {
  it('tokenizes Korean descriptions', () => {
    const index = new SkillSearchIndex();
    index.build([makeSkill('korean-skill', '한국어 스킬 설명입니다')]);
    const results = index.search('한국어 스킬');
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe('korean-skill');
  });

  it('tokenizes Portuguese accented words', () => {
    const index = new SkillSearchIndex();
    index.build([makeSkill('pt-skill', 'Otimização de performance com cache')]);
    const results = index.search('otimização');
    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe('pt-skill');
  });

  it('returns empty when no result meets the minimum score threshold', () => {
    const index = new SkillSearchIndex();
    index.build([makeSkill('docker-expert', 'Docker containerization')]);
    const results = index.search('react component', 10, 0.1);
    expect(results).toHaveLength(0);
  });

  it('returns low-relevance results when threshold is zero', () => {
    const index = new SkillSearchIndex();
    index.build([makeSkill('docker-expert', 'Docker containerization')]);
    const results = index.search('react container', 10, 0);
    expect(results.length).toBeGreaterThan(0);
  });

  it('finds skills by body snippet keywords', () => {
    const index = new SkillSearchIndex();
    index.build([
      {
        ...makeSkill('api-skill', 'API design patterns'),
        bodySnippet: 'Covers graphql and rest endpoints.',
      },
    ]);
    const results = index.search('graphql');
    expect(results.some((r) => r.name === 'api-skill')).toBe(true);
  });

  it('matches skills by aliases metadata', () => {
    const index = new SkillSearchIndex();
    index.build([
      {
        ...makeSkill('containers', 'Container best practices'),
        metadata: { type: 'prompt', aliases: ['docker', 'podman'] },
      },
    ]);
    const results = index.search('docker');
    expect(results.some((r) => r.name === 'containers')).toBe(true);
  });

  it('matches skills by tags metadata', () => {
    const index = new SkillSearchIndex();
    index.build([
      {
        ...makeSkill('auth-skill', 'Authentication patterns'),
        metadata: { type: 'prompt', tags: ['oauth', 'jwt'] },
      },
    ]);
    const results = index.search('jwt');
    expect(results.some((r) => r.name === 'auth-skill')).toBe(true);
  });

  it('ranks name matches above description-only matches', () => {
    const index = new SkillSearchIndex();
    index.build([
      makeSkill('playwright-e2e', 'End-to-end testing toolkit'),
      makeSkill('generic-browser', 'Browser automation with Playwright and Selenium'),
    ]);
    const results = index.search('playwright');
    expect(results[0]?.name).toBe('playwright-e2e');
  });

  it('expands synonyms bidirectionally', () => {
    const index = new SkillSearchIndex();
    index.build([makeSkill('container-build', 'Docker container build optimization')]);
    const results = index.search('docker image build');
    expect(results.some((r) => r.name === 'container-build')).toBe(true);
  });

  it('ignores stopwords in the query', () => {
    const index = new SkillSearchIndex();
    index.build([makeSkill('docker-expert', 'Docker containerization and deployment')]);
    const results = index.search('the docker container');
    expect(results[0]?.name).toBe('docker-expert');
  });
});
