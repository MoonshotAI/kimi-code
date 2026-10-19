import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateUserHistoryStep } from '../../src/steps/user-history.js';
import { migratePlansStep } from '../../src/steps/plans.js';

let src: string;
let tgt: string;
beforeEach(async () => {
  src = await mkdtemp(join(tmpdir(), 'src-'));
  tgt = await mkdtemp(join(tmpdir(), 'tgt-'));
});
afterEach(async () => {
  await rm(src, { recursive: true, force: true });
  await rm(tgt, { recursive: true, force: true });
});

describe('migrateUserHistoryStep', () => {
  it('copies each <md5>.jsonl to target', async () => {
    await mkdir(join(src, 'user-history'), { recursive: true });
    await writeFile(join(src, 'user-history', 'aaa.jsonl'), '{"content":"echo"}\n');
    await writeFile(join(src, 'user-history', 'bbb.jsonl'), '{"content":"ls"}\n');
    const r = await migrateUserHistoryStep({ sourceHome: src, targetHome: tgt });
    expect(r.copied).toBe(2);
    expect(await readFile(join(tgt, 'user-history', 'aaa.jsonl'), 'utf-8')).toContain('echo');
  });

  it('skips files that already exist in target', async () => {
    await mkdir(join(src, 'user-history'), { recursive: true });
    await mkdir(join(tgt, 'user-history'), { recursive: true });
    await writeFile(join(src, 'user-history', 'aaa.jsonl'), '{"content":"src"}\n');
    await writeFile(join(tgt, 'user-history', 'aaa.jsonl'), '{"content":"tgt"}\n');
    const r = await migrateUserHistoryStep({ sourceHome: src, targetHome: tgt });
    expect(r.copied).toBe(0);
    expect(r.skippedExisting).toBe(1);
    expect(await readFile(join(tgt, 'user-history', 'aaa.jsonl'), 'utf-8')).toContain('tgt');
  });

  it('no source dir: zero counters', async () => {
    const r = await migrateUserHistoryStep({ sourceHome: src, targetHome: tgt });
    expect(r.copied).toBe(0);
  });

  it('does not create the target dir when there is nothing to copy', async () => {
    // Source user-history/ exists but is empty.
    await mkdir(join(src, 'user-history'), { recursive: true });
    // A file blocks the target path — mkdir there would throw.
    await writeFile(join(tgt, 'user-history'), 'blocking file');
    const r = await migrateUserHistoryStep({ sourceHome: src, targetHome: tgt });
    expect(r).toEqual({ copied: 0, skippedExisting: 0 });
  });
});

describe('migratePlansStep', () => {
  it('copies legacy plan files as plain files and skips existing on re-run', async () => {
    const plansSrc = await mkdtemp(join(tmpdir(), 'plans-src-'));
    try {
      await writeFile(join(plansSrc, 'hero-plan.md'), '# plan');
      await writeFile(join(plansSrc, 'other-plan.md'), '# other');
      const r = await migratePlansStep({ targetHome: tgt, plansSourceDir: plansSrc });
      expect(r.copied).toBe(2);
      expect(await readFile(join(tgt, 'plans', 'hero-plan.md'), 'utf-8')).toContain('# plan');

      const second = await migratePlansStep({ targetHome: tgt, plansSourceDir: plansSrc });
      expect(second.copied).toBe(0);
      expect(second.skippedExisting).toBe(2);
    } finally {
      await rm(plansSrc, { recursive: true, force: true });
    }
  });

  it('missing plans source dir: zero counters and no target dir created', async () => {
    const r = await migratePlansStep({
      targetHome: tgt,
      plansSourceDir: join(tgt, 'does-not-exist'),
    });
    expect(r).toEqual({ copied: 0, skippedExisting: 0 });
    expect(await readFile(join(tgt, 'plans', '.keep'), 'utf-8').catch(() => null)).toBeNull();
  });
});
