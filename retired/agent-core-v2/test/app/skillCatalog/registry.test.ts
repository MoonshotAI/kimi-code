import { describe, expect, it } from 'vitest';

import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import type { SkillDefinition, SkillSource } from '#/app/skillCatalog/types';
import { stubSkill } from './stubs';

describe('InMemorySkillCatalog skill listing', () => {
  it('groups skills by source under canonical section headings', () => {
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

  it('omits source headings that have no skills', () => {
    const rendered = makeRegistry([makeSkill('alpha', 'user')]).getKimiSkillsDescription();

    expect(rendered).toContain('### User');
    expect(rendered).not.toContain('### Project');
    expect(rendered).not.toContain('### Extra');
    expect(rendered).not.toContain('### Built-in');
  });

  it('renders a No skills placeholder for an empty registry', () => {
    const rendered = new InMemorySkillCatalog().getKimiSkillsDescription();

    expect(rendered.trim()).not.toBe('');
    expect(rendered).toMatch(/no skills/i);
  });

  it('sorts skills alphabetically within a source', () => {
    const rendered = makeRegistry([
      makeSkill('zebra', 'user'),
      makeSkill('alpha', 'user'),
      makeSkill('mango', 'user'),
    ]).getKimiSkillsDescription();

    const alpha = rendered.indexOf('alpha');
    const mango = rendered.indexOf('mango');
    const zebra = rendered.indexOf('zebra');
    expect(alpha).toBeGreaterThan(-1);
    expect(alpha).toBeLessThan(mango);
    expect(mango).toBeLessThan(zebra);
  });

  it('renders each skill as name, path, and description', () => {
    const rendered = makeRegistry([
      makeSkill('alpha', 'user', 'Alpha does things', '/tmp/user/alpha/SKILL.md'),
    ]).getKimiSkillsDescription();

    expect(rendered).toContain('- alpha');
    expect(rendered).toContain('  - Path: /tmp/user/alpha/SKILL.md');
    expect(rendered).toContain('  - Description: Alpha does things');
  });

  it('keeps the first registered same-name skill unless replacement is requested', () => {
    const registry = new InMemorySkillCatalog();
    registry.register(makeSkill('foo', 'project', 'project version'));
    registry.register(makeSkill('foo', 'user', 'user version'));
    registry.register(makeSkill('foo', 'builtin', 'builtin version'));

    const rendered = registry.getKimiSkillsDescription();

    expect(rendered.match(/\n- foo\n/g) ?? []).toHaveLength(1);
    expect(sectionFor(rendered, '### Project')).toContain('foo');
    expect(rendered).toContain('project version');
    expect(rendered).not.toContain('user version');
    expect(rendered).not.toContain('builtin version');
  });

  it('registerBuiltinSkill stamps non-builtin skills as builtin', () => {
    const registry = new InMemorySkillCatalog();
    registry.registerBuiltinSkill(makeSkill('theme', 'user'));

    expect(registry.getSkill('theme')).toMatchObject({
      name: 'theme',
      source: 'builtin',
    });
    expect(sectionFor(registry.getKimiSkillsDescription(), '### Built-in')).toContain('theme');
  });
});

describe('InMemorySkillCatalog model skill listing', () => {
  it('lists only model-invocable inline skills', () => {
    const registry = makeRegistry([
      makeSkill('review', 'user', 'Review code', undefined, {
        type: 'prompt',
        whenToUse: 'When reviewing changes.',
      }),
      makeSkill('private', 'user', 'Private', undefined, {
        disableModelInvocation: true,
      }),
      makeSkill('flow-only', 'user', 'Flow', undefined, { type: 'flow' }),
      makeSkill('sub-step', 'user', 'Sub', undefined, { isSubSkill: true }),
    ]);

    const rendered = registry.getModelSkillListing();

    expect(rendered).toContain('DISREGARD any earlier skill listings');
    expect(rendered).toContain('- review: Review code');
    expect(rendered).toContain('  When to use: When reviewing changes.');
    expect(rendered).toContain('  Path: /tmp/user/review/SKILL.md');
    expect(rendered).not.toContain('private');
    expect(rendered).not.toContain('flow-only');
    expect(rendered).not.toContain('sub-step');
  });

  it('returns an empty string when no skills are model-invocable', () => {
    const registry = makeRegistry([
      makeSkill('private', 'user', 'Private', undefined, {
        disableModelInvocation: true,
      }),
      makeSkill('flow-only', 'user', 'Flow', undefined, { type: 'flow' }),
    ]);

    expect(registry.getModelSkillListing()).toBe('');
  });

  it('keeps descriptions at or below the 250-character limit unchanged', () => {
    const description = 'a'.repeat(250);
    const rendered = makeRegistry([makeSkill('demo', 'user', description)]).getModelSkillListing();

    expect(rendered).toContain(`- demo: ${description}`);
    expect(rendered).not.toContain('...');
  });

  it('truncates long descriptions within the 250-character limit', () => {
    const description = 'a'.repeat(300);
    const rendered = makeRegistry([makeSkill('demo', 'user', description)]).getModelSkillListing();

    expect(rendered).toContain(`- demo: ${'a'.repeat(247)}...`);
    expect(rendered).not.toContain('a'.repeat(250));
  });

  it('does not split a grapheme cluster at the truncation boundary', () => {
    const description = `${'a'.repeat(248)}😀${'b'.repeat(100)}`;
    const rendered = makeRegistry([makeSkill('demo', 'user', description)]).getModelSkillListing();

    expect(rendered).toContain(`- demo: ${'a'.repeat(247)}...`);
    expect(rendered).not.toContain('😀');
    expect(rendered).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });
});

describe('InMemorySkillCatalog prompt rendering', () => {
  it('expands raw, positional, named, and context placeholders', () => {
    const rendered = new InMemorySkillCatalog().renderSkillPrompt(
      stubSkill('commit', {
        dir: '/tmp/skills/commit',
        content:
          'raw=$ARGUMENTS zero=$0 one=$1 second=$ARGUMENTS[1] flag=$flag message=$message dir=${KIMI_SKILL_DIR} session=${KIMI_SESSION_ID}',
        metadata: { arguments: ['flag', 'message'] },
      }),
      '-m "fix login"',
      { sessionId: 'ses_1' },
    );

    expect(rendered).toBe(
      'raw=-m "fix login" zero=-m one=fix login second=fix login flag=-m message=fix login dir=/tmp/skills/commit session=ses_1',
    );
  });

  it('leaves unknown placeholders alone and clears missing indexed values', () => {
    const rendered = new InMemorySkillCatalog().renderSkillPrompt(
      stubSkill('review', {
        dir: '/x',
        content: 'unknown=$missing actual=$0 missing=$1',
      }),
      'hello',
      { sessionId: 's' },
    );

    expect(rendered).toBe('unknown=$missing actual=hello missing=');
  });

  it('treats backslash-dollar as a normal backslash before placeholders', () => {
    const rendered = new InMemorySkillCatalog().renderSkillPrompt(
      stubSkill('review', {
        dir: '/x',
        content: String.raw`raw=\$ARGUMENTS zero=\$0 indexed=\$ARGUMENTS[1] target=\$target`,
        metadata: { arguments: ['target'] },
      }),
      'src/app.ts careful',
    );

    expect(rendered).toBe(
      String.raw`raw=\src/app.ts careful zero=\src/app.ts indexed=\careful target=\src/app.ts`,
    );
  });

  it('appends ARGUMENTS when the body has no argument placeholders', () => {
    const rendered = new InMemorySkillCatalog().renderSkillPrompt(
      stubSkill('review', { content: 'Review this file.' }),
      'src/app.ts',
    );

    expect(rendered).toBe('Review this file.\n\nARGUMENTS: src/app.ts');
  });

  it('expands context placeholders and still appends args when no argument placeholder is used', () => {
    const rendered = new InMemorySkillCatalog().renderSkillPrompt(
      stubSkill('review', {
        dir: '/skills/review',
        content: 'Use ${KIMI_SKILL_DIR}/references/checklist.md.',
      }),
      'src/app.ts',
      { sessionId: 'ses_1' },
    );

    expect(rendered).toBe(
      'Use /skills/review/references/checklist.md.\n\nARGUMENTS: src/app.ts',
    );
  });

  it('does not treat longer variable names as declared argument placeholders', () => {
    const rendered = new InMemorySkillCatalog().renderSkillPrompt(
      stubSkill('review', {
        content: 'Leave $targeted alone.',
        metadata: { arguments: ['target'] },
      }),
      'src/app.ts',
    );

    expect(rendered).toBe('Leave $targeted alone.\n\nARGUMENTS: src/app.ts');
  });

  it('accepts space-separated argument names', () => {
    const rendered = new InMemorySkillCatalog().renderSkillPrompt(
      stubSkill('review', {
        content: 'Target: $target\nMode: $mode',
        metadata: { arguments: 'target mode' },
      }),
      'src/app.ts careful',
    );

    expect(rendered).toBe('Target: src/app.ts\nMode: careful');
  });

  it('ignores numeric argument names so positional placeholders keep shell-like semantics', () => {
    const rendered = new InMemorySkillCatalog().renderSkillPrompt(
      stubSkill('review', {
        content: 'Zero: $0\nOne: $1',
        metadata: { arguments: ['1'] },
      }),
      'first second',
    );

    expect(rendered).toBe('Zero: first\nOne: second');
  });

  it('escapes argument values expanded into loaded skill content', () => {
    const rendered = new InMemorySkillCatalog().renderSkillPrompt(
      stubSkill('review', {
        content: 'target=$target raw=$ARGUMENTS',
        metadata: { arguments: ['target'] },
      }),
      '<src/app.ts> & notes',
    );

    expect(rendered).toBe('target=&lt;src/app.ts&gt; raw=&lt;src/app.ts&gt; & notes');
  });

  it('prepends plugin instructions when a skill came from a plugin root', () => {
    const rendered = new InMemorySkillCatalog().renderSkillPrompt(
      stubSkill('brainstorm', {
        content: 'Brainstorm body.',
        plugin: {
          id: 'superpowers',
          instructions: 'Use AskUserQuestion for clarifying questions.',
        },
      }),
      '',
    );

    expect(rendered).toBe(
      '<kimi-plugin-instructions plugin="superpowers">\n' +
        'Use AskUserQuestion for clarifying questions.\n' +
        '</kimi-plugin-instructions>\n\nBrainstorm body.',
    );
  });

  it('skips blank plugin instructions', () => {
    const rendered = new InMemorySkillCatalog().renderSkillPrompt(
      stubSkill('brainstorm', {
        content: 'Brainstorm body.',
        plugin: { id: 'superpowers', instructions: '  ' },
      }),
      '',
    );

    expect(rendered).toBe('Brainstorm body.');
  });
});

describe('InMemorySkillCatalog plugin lookup', () => {
  it('keeps plugin-specific lookup when a same-name project skill is registered first', () => {
    const registry = new InMemorySkillCatalog();
    registry.register(makeSkill('review', 'project', 'project skill'));
    registry.register(
      makeSkill('review', 'extra', 'plugin skill', undefined, {}, {
        id: 'superpowers',
        instructions: 'Use the plugin instructions.',
      }),
    );

    expect(registry.getSkill('review')).toMatchObject({
      description: 'project skill',
      source: 'project',
    });
    expect(registry.getPluginSkill('superpowers', 'review')).toMatchObject({
      description: 'plugin skill',
      source: 'extra',
      plugin: { id: 'superpowers' },
    });
  });

  it('replaces both global and plugin indexes when requested', () => {
    const registry = new InMemorySkillCatalog();
    registry.register(
      makeSkill('review', 'extra', 'first', undefined, {}, {
        id: 'superpowers',
      }),
    );
    registry.register(
      makeSkill('review', 'extra', 'second', undefined, {}, {
        id: 'superpowers',
      }),
      { replace: true },
    );

    expect(registry.getSkill('review')).toMatchObject({ description: 'second' });
    expect(registry.getPluginSkill('superpowers', 'review')).toMatchObject({
      description: 'second',
    });
  });
});

function makeRegistry(skills: readonly SkillDefinition[]): InMemorySkillCatalog {
  const registry = new InMemorySkillCatalog();
  for (const skill of skills) registry.register(skill);
  return registry;
}

function makeSkill(
  name: string,
  source: SkillSource,
  description = 'desc',
  skillPath?: string,
  metadata: SkillDefinition['metadata'] = { type: 'prompt' },
  plugin?: SkillDefinition['plugin'],
): SkillDefinition {
  const finalPath = skillPath ?? `/tmp/${source}/${name}/SKILL.md`;
  return stubSkill(name, {
    description,
    path: finalPath,
    dir: finalPath.replace(/\/SKILL\.md$/, ''),
    content: '',
    metadata,
    source,
    plugin,
  });
}

function sectionFor(rendered: string, header: string): string {
  const start = rendered.indexOf(header);
  if (start === -1) return '';
  const next = rendered.indexOf('### ', start + header.length);
  return next === -1 ? rendered.slice(start) : rendered.slice(start, next);
}
