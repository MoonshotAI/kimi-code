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
});
