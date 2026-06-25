import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverSkills,
  expandSkillParameters,
  type SkillDefinition,
  SessionSkillRegistry,
  type SkillRoot,
} from '../../src/skill';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('skill parser', () => {
  it('uses the filename stem when a flat .md has no frontmatter name', async () => {
    const root = await makeSkillsRoot();
    await writeFlat(root, 'my-thing.md', ['---', 'description: Something', '---', 'Body']);

    const skills = await discoverSkills({ roots: [userRoot(root)] });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('my-thing');
    expect(skills[0]?.description).toBe('Something');
  });

  it('preserves plugin metadata from the skill root', async () => {
    const root = await makeSkillsRoot();
    await writeFlat(root, 'brainstorming.md', ['---', 'description: Brainstorm', '---', 'Body']);

    const skills = await discoverSkills({
      roots: [
        {
          path: root,
          source: 'extra',
          plugin: {
            id: 'superpowers',
            instructions: 'Use AskUserQuestion.',
          },
        },
      ],
    });

    expect(skills[0]?.plugin).toEqual({
      id: 'superpowers',
      instructions: 'Use AskUserQuestion.',
    });
  });

  it('falls back to the first non-empty body line as description when frontmatter is absent', async () => {
    const root = await makeSkillsRoot();
    await writeFlat(root, 'plain.md', ['', '', 'This is the headline description.', '', 'More body text here.']);

    const skills = await discoverSkills({ roots: [userRoot(root)] });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('plain');
    expect(skills[0]?.description.toLowerCase()).toContain('headline description');
  });

  it('prefers frontmatter description over body first-line fallback', async () => {
    const root = await makeSkillsRoot();
    await writeFlat(root, 'a.md', ['---', 'description: From frontmatter', '---', 'Body first line']);

    const skills = await discoverSkills({ roots: [userRoot(root)] });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe('From frontmatter');
  });

  it('truncates body-fallback descriptions to 240 chars including trailing ellipsis', async () => {
    const root = await makeSkillsRoot();
    await writeFlat(root, 'long.md', ['a'.repeat(300)]);

    const skills = await discoverSkills({ roots: [userRoot(root)] });
    expect(skills).toHaveLength(1);
    const desc = skills[0]?.description ?? '';
    expect(desc.length).toBe(240);
    expect(desc.endsWith('…')).toBe(true);
  });

  it('does not truncate explicit frontmatter descriptions at the 240 cap', async () => {
    const root = await makeSkillsRoot();
    const longDesc = 'b'.repeat(900);
    await writeFlatOrSubdirSkill(root, 'long', 'SKILL.md', [
      '---',
      'name: long',
      `description: ${longDesc}`,
      '---',
      'Body here',
    ]);

    const skills = await discoverSkills({ roots: [userRoot(root)] });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe(longDesc);
  });

  it('flat skill frontmatter name wins over the filename stem', async () => {
    const root = await makeSkillsRoot();
    await writeFlat(root, 'filename-stem.md', ['---', 'name: real-name', 'description: ok', '---', 'Body']);

    const skills = await discoverSkills({ roots: [userRoot(root)] });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('real-name');
    expect(skills[0]?.name).not.toBe('filename-stem');
  });

  it('flat skill with unclosed frontmatter fence is skipped with a warning', async () => {
    const root = await makeSkillsRoot();
    await writeFlat(root, 'demo.md', ['---', '# Hello', 'Body text.']);

    const warnings: string[] = [];
    const skills = await discoverSkills({
      roots: [userRoot(root)],
      onWarning: (message) => warnings.push(message),
    });
    expect(skills).toEqual([]);
    expect(warnings.some((message) => message.includes('Invalid frontmatter'))).toBe(true);
  });

  it('subdir skill with unclosed frontmatter fence is skipped with a warning', async () => {
    const root = await makeSkillsRoot();
    await writeFlatOrSubdirSkill(root, 'demo', 'SKILL.md', ['---', '# Heading', 'Body.']);

    const warnings: string[] = [];
    const skills = await discoverSkills({
      roots: [userRoot(root)],
      onWarning: (message) => warnings.push(message),
    });
    expect(skills).toEqual([]);
    expect(warnings.some((message) => message.includes('Invalid frontmatter'))).toBe(true);
  });
});

describe('skill parameter expansion', () => {
  it('expands raw, positional, named, and context placeholders', () => {
    const out = expandSkillParameters(
      'raw=$ARGUMENTS zero=$0 one=$1 second=$ARGUMENTS[1] flag=$flag message=$message dir=${KIMI_SKILL_DIR} session=${KIMI_SESSION_ID}',
      '-m "fix login"',
      {
        skillDir: '/tmp/skills/commit',
        sessionId: 'ses_1',
        argumentNames: ['flag', 'message'],
      },
    );

    expect(out).toBe(
      'raw=-m "fix login" zero=-m one=fix login second=fix login flag=-m message=fix login dir=/tmp/skills/commit session=ses_1',
    );
  });

  it('leaves unknown placeholders alone and clears missing indexed values', () => {
    const out = expandSkillParameters('unknown=$missing actual=$0 missing=$1', 'hello', {
      skillDir: '/x',
      sessionId: 's',
    });

    expect(out).toBe('unknown=$missing actual=hello missing=');
  });

  it('treats backslash-dollar as a normal backslash before placeholders', () => {
    const out = expandSkillParameters(
      String.raw`raw=\$ARGUMENTS zero=\$0 indexed=\$ARGUMENTS[1] target=\$target`,
      'src/app.ts careful',
      {
        skillDir: '/x',
        argumentNames: ['target'],
      },
    );

    expect(out).toBe(
      String.raw`raw=\src/app.ts careful zero=\src/app.ts indexed=\careful target=\src/app.ts`,
    );
  });
});

describe('SkillRegistry.renderSkillPrompt', () => {
  it('expands argument placeholders without appending duplicate arguments', () => {
    const rendered = new SessionSkillRegistry().renderSkillPrompt(
      testSkill({
        content: 'Review $target from $ARGUMENTS.',
        metadata: { arguments: ['target'] },
      }),
      '"src/app.ts" carefully',
    );

    expect(rendered).toBe('Review src/app.ts from "src/app.ts" carefully.');
    expect(rendered).not.toContain('ARGUMENTS:');
  });

  it('appends ARGUMENTS when the body has no argument placeholders', () => {
    const rendered = new SessionSkillRegistry().renderSkillPrompt(
      testSkill({ content: 'Review this file.' }),
      'src/app.ts',
    );

    expect(rendered).toBe('Review this file.\n\nARGUMENTS: src/app.ts');
  });

  it('expands context placeholders and still appends args when no argument placeholder is used', () => {
    const rendered = new SessionSkillRegistry({ sessionId: 'ses_1' }).renderSkillPrompt(
      testSkill({ content: 'Use ${KIMI_SKILL_DIR}/references/checklist.md.' }),
      'src/app.ts',
    );

    expect(rendered).toBe(
      'Use /skills/review/references/checklist.md.\n\nARGUMENTS: src/app.ts',
    );
  });

  it('does not treat longer variable names as declared argument placeholders', () => {
    const rendered = new SessionSkillRegistry().renderSkillPrompt(
      testSkill({
        content: 'Leave $targeted alone.',
        metadata: { arguments: ['target'] },
      }),
      'src/app.ts',
    );

    expect(rendered).toBe('Leave $targeted alone.\n\nARGUMENTS: src/app.ts');
  });

  it('accepts space-separated argument names', () => {
    const rendered = new SessionSkillRegistry().renderSkillPrompt(
      testSkill({
        content: 'Target: $target\nMode: $mode',
        metadata: { arguments: 'target mode' },
      }),
      'src/app.ts careful',
    );

    expect(rendered).toBe('Target: src/app.ts\nMode: careful');
  });

  it('ignores numeric argument names so positional placeholders keep shell-like semantics', () => {
    const rendered = new SessionSkillRegistry().renderSkillPrompt(
      testSkill({
        content: 'Zero: $0\nOne: $1',
        metadata: { arguments: ['1'] },
      }),
      'first second',
    );

    expect(rendered).toBe('Zero: first\nOne: second');
  });

  it('prepends plugin instructions when a skill came from a plugin root', () => {
    const rendered = new SessionSkillRegistry().renderSkillPrompt(
      testSkill({
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
});

async function makeSkillsRoot(): Promise<string> {
  const tmp = await mkdtemp(path.join(tmpdir(), 'kimi-skill-parser-'));
  tempDirs.push(tmp);
  const root = path.join(tmp, 'skills');
  await mkdir(root, { recursive: true });
  return root;
}

function userRoot(root: string): SkillRoot {
  return { path: root, source: 'user' };
}

async function writeFlat(root: string, name: string, lines: readonly string[]): Promise<void> {
  await writeFile(path.join(root, name), lines.join('\n'));
}

async function writeFlatOrSubdirSkill(
  root: string,
  dirName: string,
  fileName: string,
  lines: readonly string[],
): Promise<void> {
  const dir = path.join(root, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), lines.join('\n'));
}

function testSkill(input: {
  readonly content: string;
  readonly metadata?: SkillDefinition['metadata'];
  readonly plugin?: SkillDefinition['plugin'];
}): SkillDefinition {
  return {
    name: 'review',
    description: 'Review things',
    path: '/skills/review/SKILL.md',
    dir: '/skills/review',
    content: input.content,
    metadata: input.metadata ?? {},
    source: 'user',
    plugin: input.plugin,
  };
}
