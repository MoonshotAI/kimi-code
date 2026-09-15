import { describe, expect, it } from 'vitest';

import {
  extractInlineSkillActivations,
  findInlineSkillTokens,
} from '#/tui/utils/inline-skill-tokens';

const SKILL_COMMAND_MAP = new Map([
  ['skill:review', 'review'],
  ['skill:security', 'security'],
  ['commit', 'commit'],
]);

function findAll(text: string, includeLeading = false) {
  return findInlineSkillTokens(text, {
    isKnownSkill: (name) => SKILL_COMMAND_MAP.has(name) || SKILL_COMMAND_MAP.has(`skill:${name}`),
    includeLeading,
  });
}

describe('findInlineSkillTokens', () => {
  it('finds tokens preceded by whitespace in first-occurrence order', () => {
    expect(findAll('please /skill:review and /skill:security this')).toEqual([
      { commandName: 'skill:review', start: 7, end: 20 },
      { commandName: 'skill:security', start: 25, end: 40 },
    ]);
  });

  it('skips the leading slash-command area by default', () => {
    expect(findAll('/skill:review')).toEqual([]);
    expect(findAll('/skill:review')).toHaveLength(0);
    expect(findAll('/skill:review', true)).toEqual([
      { commandName: 'skill:review', start: 0, end: 13 },
    ]);
  });

  it('finds tokens after the leading command and its arguments', () => {
    expect(findAll('/skill:review some args /skill:security')).toEqual([
      { commandName: 'skill:security', start: 24, end: 39 },
    ]);
  });

  it('treats a newline as whitespace, so multi-line prompts work', () => {
    expect(findAll('first line\n/skill:review more')).toEqual([
      { commandName: 'skill:review', start: 11, end: 24 },
    ]);
  });

  it('ignores slashes inside words, paths, and URLs', () => {
    expect(findAll('and/or')).toEqual([]);
    expect(findAll('see /tmp/file and https://example.com/a')).toEqual([]);
    expect(findAll('1/2')).toEqual([]);
  });

  it('ignores unknown command names', () => {
    expect(findAll('hello /not-a-skill world')).toEqual([]);
  });
});

describe('extractInlineSkillActivations', () => {
  it('resolves command names to skill names, deduped in first-occurrence order', () => {
    expect(
      extractInlineSkillActivations(
        '/skill:review then /skill:review again /skill:security',
        SKILL_COMMAND_MAP,
        { includeLeading: true },
      ),
    ).toEqual([{ skillName: 'review' }, { skillName: 'security' }]);
  });

  it('supports the skill: prefix fallback for bare names', () => {
    expect(extractInlineSkillActivations('hello /review', SKILL_COMMAND_MAP)).toEqual([
      { skillName: 'review' },
    ]);
  });

  it('keeps builtin skill command names as-is', () => {
    expect(extractInlineSkillActivations('please /commit this', SKILL_COMMAND_MAP)).toEqual([
      { skillName: 'commit' },
    ]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(extractInlineSkillActivations('no tokens here', SKILL_COMMAND_MAP)).toEqual([]);
  });
});
