import { describe, expect, it } from 'vitest';

import {
  FrontmatterError,
  SkillParseError,
  UnsupportedSkillTypeError,
  parseFrontmatter,
  parseSkillText,
} from '#/app/skillCatalog/parser';

describe('parseFrontmatter', () => {
  it('parses yaml frontmatter and body', () => {
    const { data, body } = parseFrontmatter('---\nname: foo\n---\nbody text');
    expect(data).toEqual({ name: 'foo' });
    expect(body).toBe('body text');
  });

  it('returns null data when there is no frontmatter', () => {
    const { data, body } = parseFrontmatter('just body');
    expect(data).toBeNull();
    expect(body).toBe('just body');
  });

  it('throws when the closing fence is missing', () => {
    expect(() => parseFrontmatter('---\nname: foo')).toThrow(FrontmatterError);
  });
});

describe('parseSkillText', () => {
  it('parses a directory skill with required fields', () => {
    const skill = parseSkillText({
      skillMdPath: '/skills/commit/SKILL.md',
      skillDirName: 'commit',
      source: 'user',
      text: '---\nname: commit\ndescription: commit changes\n---\n# Commit',
    });
    expect(skill.name).toBe('commit');
    expect(skill.description).toBe('commit changes');
    expect(skill.source).toBe('user');
    expect(skill.content).toBe('# Commit');
  });

  it('applies metadata aliases', () => {
    const skill = parseSkillText({
      skillMdPath: '/skills/x/SKILL.md',
      skillDirName: 'x',
      source: 'user',
      text: '---\nname: x\ndescription: d\nwhen-to-use: when X\ndisable_model_invocation: true\n---\nbody',
    });
    expect(skill.metadata.whenToUse).toBe('when X');
    expect(skill.metadata.disableModelInvocation).toBe(true);
  });

  it('throws when a directory skill misses a required field', () => {
    expect(() =>
      parseSkillText({
        skillMdPath: '/skills/x/SKILL.md',
        skillDirName: 'x',
        source: 'user',
        text: '---\ndescription: d\n---\nbody',
      }),
    ).toThrow(SkillParseError);
  });

  it('throws when a directory skill has no frontmatter', () => {
    expect(() =>
      parseSkillText({
        skillMdPath: '/skills/x/SKILL.md',
        skillDirName: 'x',
        source: 'user',
        text: '# no frontmatter',
      }),
    ).toThrow(SkillParseError);
  });

  it('falls back to dir name and body description for flat skills', () => {
    const skill = parseSkillText({
      skillMdPath: '/skills/foo.md',
      skillDirName: 'foo',
      source: 'user',
      text: '# Foo skill\n\nDoes foo.',
    });
    expect(skill.name).toBe('foo');
    expect(skill.description).toBe('# Foo skill');
  });

  it('throws on an unsupported skill type', () => {
    expect(() =>
      parseSkillText({
        skillMdPath: '/skills/x/SKILL.md',
        skillDirName: 'x',
        source: 'user',
        text: '---\nname: x\ndescription: d\ntype: bogus\n---\nbody',
      }),
    ).toThrow(UnsupportedSkillTypeError);
  });

  it('extracts mermaid and d2 flowchart blocks', () => {
    const skill = parseSkillText({
      skillMdPath: '/skills/x/SKILL.md',
      skillDirName: 'x',
      source: 'user',
      text: '---\nname: x\ndescription: d\n---\n```mermaid\ngraph TD\n```\n\n```d2\nx -> y\n```',
    });
    expect(skill.mermaid).toBe('graph TD');
    expect(skill.d2).toBe('x -> y');
  });
});
