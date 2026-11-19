import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMigrationErrorsLog } from '../src/migration-errors-log.js';
import { migrationErrorsLogFile } from '../src/paths.js';

let tgt: string;
let src: string;
beforeEach(async () => {
  tgt = await mkdtemp(join(tmpdir(), 'errlog-tgt-'));
  src = await mkdtemp(join(tmpdir(), 'errlog-src-'));
});
afterEach(async () => {
  await rm(tgt, { recursive: true, force: true });
  await rm(src, { recursive: true, force: true });
});

describe('writeMigrationErrorsLog', () => {
  it('appends a "no failures" marker block on a successful run', async () => {
    await writeMigrationErrorsLog(tgt, {
      startedAt: '2026-05-19T00:00:00Z',
      failures: [],
    });
    const log = await readFile(migrationErrorsLogFile(tgt), 'utf-8');
    expect(log).toContain('===== migration run @ 2026-05-19T00:00:00Z =====');
    expect(log).toContain('no failures.');
  });

  it('writes a diagnostic block per failure with a context.jsonl role histogram', async () => {
    const sessionDir = join(src, 'ses-1');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'context.jsonl'),
      '{"role":"_system_prompt","content":"x"}\n{"role":"user","content":"hi"}\n',
    );

    await writeMigrationErrorsLog(tgt, {
      startedAt: '2026-05-19T00:00:00Z',
      failures: [{ sourcePath: sessionDir, reason: 'write failed: ENOSPC' }],
    });

    const log = await readFile(migrationErrorsLogFile(tgt), 'utf-8');
    expect(log).toContain('===== migration run @ 2026-05-19T00:00:00Z =====');
    expect(log).toContain('1 session(s) failed to migrate.');
    expect(log).toContain(sessionDir);
    expect(log).toContain('write failed: ENOSPC');
    expect(log).toContain('context.jsonl: 2 lines');
    expect(log).toContain('_system_prompt=1');
    expect(log).toContain('user=1');
  });

  it('notes an unreadable context.jsonl rather than throwing', async () => {
    const sessionDir = join(src, 'gone');
    await writeMigrationErrorsLog(tgt, {
      startedAt: '2026-05-19T00:00:00Z',
      failures: [{ sourcePath: sessionDir, reason: 'cannot read context.jsonl' }],
    });
    const log = await readFile(migrationErrorsLogFile(tgt), 'utf-8');
    expect(log).toContain('context.jsonl: unreadable');
  });

  it('appends a second block when a later run also has failures', async () => {
    const ses1 = join(src, 'ses-1');
    const ses2 = join(src, 'ses-2');
    await mkdir(ses1, { recursive: true });
    await mkdir(ses2, { recursive: true });
    await writeFile(join(ses1, 'context.jsonl'), '{"role":"user","content":"a"}\n');
    await writeFile(join(ses2, 'context.jsonl'), '{"role":"user","content":"b"}\n');

    await writeMigrationErrorsLog(tgt, {
      startedAt: '2026-05-19T00:00:00Z',
      failures: [{ sourcePath: ses1, reason: 'first-run reason' }],
    });
    await writeMigrationErrorsLog(tgt, {
      startedAt: '2026-05-20T00:00:00Z',
      failures: [{ sourcePath: ses2, reason: 'second-run reason' }],
    });

    const log = await readFile(migrationErrorsLogFile(tgt), 'utf-8');
    const headerMatches = log.match(/===== migration run @ /g) ?? [];
    expect(headerMatches).toHaveLength(2);
    expect(log).toContain('2026-05-19T00:00:00Z');
    expect(log).toContain('2026-05-20T00:00:00Z');
    expect(log).toContain('first-run reason');
    expect(log).toContain('second-run reason');
    expect(log).toContain(ses1);
    expect(log).toContain(ses2);
  });

  it('appends after an earlier failed run when the later run has no failures', async () => {
    const ses1 = join(src, 'ses-1');
    await mkdir(ses1, { recursive: true });
    await writeFile(join(ses1, 'context.jsonl'), '{"role":"user","content":"a"}\n');

    await writeMigrationErrorsLog(tgt, {
      startedAt: '2026-05-19T00:00:00Z',
      failures: [{ sourcePath: ses1, reason: 'first-run reason' }],
    });
    await writeMigrationErrorsLog(tgt, {
      startedAt: '2026-05-20T00:00:00Z',
      failures: [],
    });

    const log = await readFile(migrationErrorsLogFile(tgt), 'utf-8');
    expect(log).toContain('===== migration run @ 2026-05-19T00:00:00Z =====');
    expect(log).toContain('first-run reason');
    expect(log).toContain('===== migration run @ 2026-05-20T00:00:00Z =====');
    expect(log).toContain('no failures.');
  });
});
