import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateSkillsStep } from '../../src/steps/skills.js';

let src: string;
let tgt: string;
beforeEach(async () => {
  src = await mkdtemp(join(tmpdir(), 'skills-src-'));
  tgt = await mkdtemp(join(tmpdir(), 'skills-tgt-'));
});
afterEach(async () => {
  await rm(src, { recursive: true, force: true });
  await rm(tgt, { recursive: true, force: true });
});

describe('migrateSkillsStep', () => {
  it('copies SKILL.md bundles and flat .md skills under ~/.kimi/skills/', async () => {
    await mkdir(join(src, 'skills', 'my-skill'), { recursive: true });
    await writeFile(
      join(src, 'skills', 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: x\n---\nbody\n',
    );
    await writeFile(
      join(src, 'skills', 'flat-skill.md'),
      '---\nname: flat-skill\ndescription: y\n---\nflat\n',
    );

    const r = await migrateSkillsStep({ sourceHome: src, targetHome: tgt });

    expect(r.copied).toBe(2);
    expect(r.skippedExisting).toBe(0);
    expect(await readFile(join(tgt, 'skills', 'my-skill', 'SKILL.md'), 'utf-8')).toContain('body');
    expect(await readFile(join(tgt, 'skills', 'flat-skill.md'), 'utf-8')).toContain('flat');
  });

  it('recursively copies bundle contents (references/scripts subdirs)', async () => {
    await mkdir(join(src, 'skills', 'bundle', 'references'), { recursive: true });
    await mkdir(join(src, 'skills', 'bundle', 'scripts'), { recursive: true });
    await writeFile(
      join(src, 'skills', 'bundle', 'SKILL.md'),
      '---\nname: bundle\ndescription: z\n---\n',
    );
    await writeFile(join(src, 'skills', 'bundle', 'references', 'ref.md'), 'ref-body');
    await writeFile(join(src, 'skills', 'bundle', 'scripts', 'run.sh'), '#!/bin/sh\necho hi');

    const r = await migrateSkillsStep({ sourceHome: src, targetHome: tgt });

    expect(r.copied).toBe(1);
    expect(await readFile(join(tgt, 'skills', 'bundle', 'references', 'ref.md'), 'utf-8')).toBe(
      'ref-body',
    );
    expect(await readFile(join(tgt, 'skills', 'bundle', 'scripts', 'run.sh'), 'utf-8')).toContain(
      'echo hi',
    );
  });

  it('skips entries whose name already exists in target (no overwrite)', async () => {
    await mkdir(join(src, 'skills', 'shared'), { recursive: true });
    await writeFile(join(src, 'skills', 'shared', 'SKILL.md'), 'SRC');
    await writeFile(join(src, 'skills', 'flat.md'), 'SRC-FLAT');

    await mkdir(join(tgt, 'skills', 'shared'), { recursive: true });
    await writeFile(join(tgt, 'skills', 'shared', 'SKILL.md'), 'TGT');
    await writeFile(join(tgt, 'skills', 'flat.md'), 'TGT-FLAT');

    const r = await migrateSkillsStep({ sourceHome: src, targetHome: tgt });

    expect(r.copied).toBe(0);
    expect(r.skippedExisting).toBe(2);
    expect(await readFile(join(tgt, 'skills', 'shared', 'SKILL.md'), 'utf-8')).toBe('TGT');
    expect(await readFile(join(tgt, 'skills', 'flat.md'), 'utf-8')).toBe('TGT-FLAT');
  });

  it('mixes copied + skippedExisting in one run', async () => {
    await mkdir(join(src, 'skills', 'already-there'), { recursive: true });
    await mkdir(join(src, 'skills', 'fresh'), { recursive: true });
    await writeFile(join(src, 'skills', 'already-there', 'SKILL.md'), 'SRC');
    await writeFile(join(src, 'skills', 'fresh', 'SKILL.md'), 'NEW');

    await mkdir(join(tgt, 'skills', 'already-there'), { recursive: true });
    await writeFile(join(tgt, 'skills', 'already-there', 'SKILL.md'), 'TGT');

    const r = await migrateSkillsStep({ sourceHome: src, targetHome: tgt });

    expect(r.copied).toBe(1);
    expect(r.skippedExisting).toBe(1);
    expect(await readFile(join(tgt, 'skills', 'fresh', 'SKILL.md'), 'utf-8')).toBe('NEW');
    expect(await readFile(join(tgt, 'skills', 'already-there', 'SKILL.md'), 'utf-8')).toBe('TGT');
  });

  it('returns zero counters when source ~/.kimi/skills/ is missing', async () => {
    const r = await migrateSkillsStep({ sourceHome: src, targetHome: tgt });
    expect(r).toEqual({ copied: 0, skippedExisting: 0 });
    expect(existsSync(join(tgt, 'skills'))).toBe(false);
  });

  it('does not create the target dir when there is nothing to copy', async () => {
    // Empty source skills/ — no files to copy, target dir must stay untouched.
    await mkdir(join(src, 'skills'), { recursive: true });
    const r = await migrateSkillsStep({ sourceHome: src, targetHome: tgt });
    expect(r).toEqual({ copied: 0, skippedExisting: 0 });
    expect(existsSync(join(tgt, 'skills'))).toBe(false);
  });

  it('copies non-skill files at top level too (no filtering)', async () => {
    // We intentionally do not filter — whatever the user kept under
    // ~/.kimi/skills/ is preserved verbatim. The new scanner ignores anything
    // that does not match the skill shape.
    await mkdir(join(src, 'skills'), { recursive: true });
    await writeFile(join(src, 'skills', 'NOTES.txt'), 'stray notes');

    const r = await migrateSkillsStep({ sourceHome: src, targetHome: tgt });
    expect(r.copied).toBe(1);
    expect(await readFile(join(tgt, 'skills', 'NOTES.txt'), 'utf-8')).toBe('stray notes');
  });

  it('atomic write: leaves no .tmp leftovers in target on success', async () => {
    await mkdir(join(src, 'skills'), { recursive: true });
    await writeFile(join(src, 'skills', 'a.md'), 'A');

    await migrateSkillsStep({ sourceHome: src, targetHome: tgt });

    const entries = await readdir(join(tgt, 'skills'));
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });
});
