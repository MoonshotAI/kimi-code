import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateSessionsStep } from '../../src/sessions/index.js';
import { oldMd5BucketName } from '../../src/sessions/workdir-bucket.js';
import { targetSessionIndex } from '../../src/paths.js';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const FIXTURE_KIMI = join(FIXTURES, 'multi-workdir', '.kimi');

// md5("/proj-b") — bucket for placeholder + empty cases.
const PROJ_B_BUCKET = 'dbf62706c1b976e79a5e7cfcc3491a1f';

let targetHome: string;
beforeEach(async () => {
  targetHome = await mkdtemp(join(tmpdir(), 'sessions-step-'));
  // Empty dirs cannot live in git, so materialize `uuid-b2` before each run.
  await mkdir(join(FIXTURE_KIMI, 'sessions', PROJ_B_BUCKET, 'uuid-b2'), { recursive: true });
});
afterEach(async () => {
  await rm(targetHome, { recursive: true, force: true });
  await rm(join(FIXTURE_KIMI, 'sessions', PROJ_B_BUCKET, 'uuid-b2'), {
    recursive: true,
    force: true,
  });
});

describe('migrateSessionsStep (multi-workdir fixture)', () => {
  it('migrates real local sessions, skips placeholders/empty, skips non-local kaos', async () => {
    const report = await migrateSessionsStep({
      sourceHome: FIXTURE_KIMI,
      targetHome,
    });
    expect(report.bucketsScanned).toBe(3);
    expect(report.bucketsSkippedNonlocalKaos).toBe(1);
    expect(report.bucketsSkippedNoWorkdirFound).toBe(0);
    expect(report.sessionsMigrated).toBe(2); // a1, a2
    expect(report.sessionsSkippedPlaceholder).toBe(1);
    expect(report.sessionsSkippedEmpty).toBe(1);
    expect(report.sessionsFailed).toEqual([]);
  });

  it('counts a migrated session as failed when its index entry cannot be written', async () => {
    // Make `session_index.jsonl` a directory so `appendSessionIndexEntry` fails.
    await mkdir(targetSessionIndex(targetHome), { recursive: true });
    const report = await migrateSessionsStep({
      sourceHome: FIXTURE_KIMI,
      targetHome,
    });
    // Both sessions land on disk, but a session with no index entry is
    // unopenable by id — it must be reported as failed, not migrated.
    expect(report.sessionsMigrated).toBe(0);
    expect(report.sessionsFailed).toHaveLength(2);
  });

  it('counts an already-migrated session as failed when its index entry cannot be ensured', async () => {
    // First run migrates cleanly and writes the index.
    await migrateSessionsStep({ sourceHome: FIXTURE_KIMI, targetHome });
    // Simulate a crash that left the index missing, then make it unwritable.
    const indexPath = targetSessionIndex(targetHome);
    await rm(indexPath, { force: true });
    await mkdir(indexPath, { recursive: true });
    // The second run sees the session dirs and takes the already-migrated path.
    const report = await migrateSessionsStep({
      sourceHome: FIXTURE_KIMI,
      targetHome,
    });
    expect(report.sessionsAlreadyMigrated).toBe(0);
    expect(report.sessionsFailed).toHaveLength(2);
  });

  it('does not duplicate an index entry when a deleted session is re-migrated', async () => {
    // First run: both sessions migrated, index has two entries.
    await migrateSessionsStep({ sourceHome: FIXTURE_KIMI, targetHome });
    // The user deletes one migrated session's target dir, but its index line
    // survives. A re-run re-migrates that session from scratch.
    const indexPath = targetSessionIndex(targetHome);
    const firstLine = (await readFile(indexPath, 'utf-8'))
      .split('\n')
      .find((l) => l.length > 0)!;
    await rm((JSON.parse(firstLine) as { sessionDir: string }).sessionDir, {
      recursive: true,
      force: true,
    });
    await migrateSessionsStep({ sourceHome: FIXTURE_KIMI, targetHome });
    // The re-migrated session must not pick up a second index line.
    const ids = (await readFile(indexPath, 'utf-8'))
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => (JSON.parse(l) as { sessionId: string }).sessionId);
    const seen = new Map<string, number>();
    for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
    for (const count of seen.values()) expect(count).toBe(1);
  });

  it('emits per-session progress (done, total) for each migrated session', async () => {
    const events: Array<{ done: number; total: number }> = [];
    await migrateSessionsStep({
      sourceHome: FIXTURE_KIMI,
      targetHome,
      onSessionProgress: (done, total) => events.push({ done, total }),
    });
    // multi-workdir fixture migrates 2 real local sessions
    expect(events).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });

  it('routes a corrupt context.jsonl into sessionsFailed (so it reaches migration-errors.log)', async () => {
    // A session whose `context.jsonl` is unparseable is a real data problem.
    // It must not be silently absorbed into `sessionsSkippedMalformed` (which
    // the result screen does not render and `migration-errors.log` does not
    // include); it must surface as a real failure with diagnostic info.
    const src = await mkdtemp(join(tmpdir(), 'corrupt-sess-src-'));
    try {
      const workdir = '/Users/me/corrupt-proj';
      await writeFile(
        join(src, 'kimi.json'),
        JSON.stringify({ work_dirs: [{ path: workdir, kaos: 'local' }] }),
      );
      const bucket = join(src, 'sessions', oldMd5BucketName(workdir));
      await mkdir(join(bucket, 'corrupt-uuid'), { recursive: true });
      await writeFile(
        join(bucket, 'corrupt-uuid', 'context.jsonl'),
        'not-json\n{broken\n}}}\n',
      );
      await writeFile(join(bucket, 'corrupt-uuid', 'state.json'), '{}');

      const report = await migrateSessionsStep({ sourceHome: src, targetHome });

      expect(report.sessionsFailed).toHaveLength(1);
      expect(report.sessionsFailed[0]!.sourcePath).toContain('corrupt-uuid');
      expect(report.sessionsFailed[0]!.reason).toMatch(/corrupt|parseable/i);
      expect(report.sessionsSkippedMalformed).toBe(0);
      expect(report.sessionsMigrated).toBe(0);
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });

  it('counts a content-empty session as skipped-empty (not failed) and still migrates the real one', async () => {
    // A session whose context.jsonl holds only markers (the user cleared it
    // in kimi-cli) must be reported as skipped-empty — not failed — without
    // interfering with the real session beside it.
    const src = await mkdtemp(join(tmpdir(), 'empty-sess-src-'));
    try {
      const workdir = '/Users/me/empty-proj';
      await writeFile(
        join(src, 'kimi.json'),
        JSON.stringify({ work_dirs: [{ path: workdir, kaos: 'local' }] }),
      );
      const bucket = join(src, 'sessions', oldMd5BucketName(workdir));
      await mkdir(join(bucket, 'real-uuid'), { recursive: true });
      await writeFile(
        join(bucket, 'real-uuid', 'context.jsonl'),
        '{"role":"user","content":"hi"}\n' +
          '{"role":"assistant","content":[{"type":"text","text":"yo"}]}\n',
      );
      await writeFile(join(bucket, 'real-uuid', 'state.json'), '{}');
      await mkdir(join(bucket, 'empty-uuid'), { recursive: true });
      await writeFile(
        join(bucket, 'empty-uuid', 'context.jsonl'),
        '{"role":"_system_prompt","content":"x"}\n',
      );
      await writeFile(join(bucket, 'empty-uuid', 'state.json'), '{}');

      const report = await migrateSessionsStep({ sourceHome: src, targetHome });

      expect(report.sessionsFailed).toHaveLength(0);
      expect(report.sessionsSkippedEmpty).toBe(1);
      expect(report.sessionsMigrated).toBe(1);
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });

  it('reports a non-empty session without context.jsonl as a failure', async () => {
    const src = await mkdtemp(join(tmpdir(), 'missing-context-src-'));
    try {
      const workdir = '/Users/me/missing-context-project';
      await writeFile(
        join(src, 'kimi.json'),
        JSON.stringify({ work_dirs: [{ path: workdir, kaos: 'local' }] }),
      );
      const sessionDir = join(src, 'sessions', oldMd5BucketName(workdir), 'missing-context');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, 'state.json'), '{}');

      const report = await migrateSessionsStep({ sourceHome: src, targetHome });

      expect(report.sessionsFailed).toEqual([
        {
          sourcePath: sessionDir,
          reason: expect.stringMatching(/context\.jsonl.*missing.*unreadable/i),
        },
      ]);
      expect(report.sessionsSkippedMalformed).toBe(0);
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });

  it('reports a context.jsonl that cannot be read as a failure', async () => {
    const src = await mkdtemp(join(tmpdir(), 'unreadable-context-src-'));
    try {
      const workdir = '/Users/me/unreadable-context-project';
      await writeFile(
        join(src, 'kimi.json'),
        JSON.stringify({ work_dirs: [{ path: workdir, kaos: 'local' }] }),
      );
      const sessionDir = join(src, 'sessions', oldMd5BucketName(workdir), 'bad-context');
      await mkdir(join(sessionDir, 'context.jsonl'), { recursive: true });

      const report = await migrateSessionsStep({ sourceHome: src, targetHome });

      expect(report.sessionsFailed).toEqual([
        {
          sourcePath: sessionDir,
          reason: expect.stringMatching(/context\.jsonl.*unreadable/i),
        },
      ]);
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });

  it('reports an unknown workdir bucket as a failure', async () => {
    const src = await mkdtemp(join(tmpdir(), 'unknown-workdir-src-'));
    try {
      const bucket = join(src, 'sessions', oldMd5BucketName('/workspace/not-registered'));
      await mkdir(join(bucket, 'legacy-session'), { recursive: true });

      const report = await migrateSessionsStep({ sourceHome: src, targetHome });

      expect(report.bucketsSkippedNoWorkdirFound).toBe(1);
      expect(report.sessionsFailed).toEqual([
        {
          sourcePath: bucket,
          reason: expect.stringMatching(/workdir.*kimi\.json/i),
        },
      ]);
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });

  it('reports a bucket that cannot be read as a failure', async () => {
    const src = await mkdtemp(join(tmpdir(), 'unreadable-bucket-src-'));
    try {
      const workdir = '/Users/me/unreadable-bucket-project';
      await writeFile(
        join(src, 'kimi.json'),
        JSON.stringify({ work_dirs: [{ path: workdir, kaos: 'local' }] }),
      );
      const bucket = join(src, 'sessions', oldMd5BucketName(workdir));
      await mkdir(join(src, 'sessions'), { recursive: true });
      await writeFile(bucket, 'not a directory');

      const report = await migrateSessionsStep({ sourceHome: src, targetHome });

      expect(report.sessionsFailed).toEqual([
        {
          sourcePath: bucket,
          reason: expect.stringMatching(/bucket could not be read/i),
        },
      ]);
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });
});
