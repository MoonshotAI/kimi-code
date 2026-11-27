import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendSessionIndexEntry, ensureSessionIndexEntry } from '../src/session-index.js';

let target: string;
beforeEach(async () => {
  target = await mkdtemp(join(tmpdir(), 'sess-idx-'));
});
afterEach(async () => {
  await rm(target, { recursive: true, force: true });
});

describe('appendSessionIndexEntry', () => {
  it('creates the file and appends one line per call', async () => {
    await appendSessionIndexEntry(target, {
      sessionId: 'ses_a',
      sessionDir: '/abs/a',
      workDir: '/abs/wd',
    });
    await appendSessionIndexEntry(target, {
      sessionId: 'ses_b',
      sessionDir: '/abs/b',
      workDir: '/abs/wd',
    });
    const text = await readFile(join(target, 'session_index.jsonl'), 'utf-8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const first = lines[0];
    const second = lines[1];
    if (first === undefined || second === undefined) {
      throw new Error('expected two non-empty lines');
    }
    expect(JSON.parse(first).sessionId).toBe('ses_a');
    expect(JSON.parse(second).sessionId).toBe('ses_b');
  });
});

describe('ensureSessionIndexEntry', () => {
  it('appends the entry when the index is missing it', async () => {
    await ensureSessionIndexEntry(target, {
      sessionId: 'ses_x',
      sessionDir: '/abs/x',
      workDir: '/abs/wd',
    });
    const text = await readFile(join(target, 'session_index.jsonl'), 'utf-8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const only = lines[0];
    if (only === undefined) throw new Error('expected one line');
    expect(JSON.parse(only).sessionId).toBe('ses_x');
  });

  it('is a no-op when an entry with the same sessionId already exists', async () => {
    await appendSessionIndexEntry(target, {
      sessionId: 'ses_x',
      sessionDir: '/abs/x',
      workDir: '/abs/wd',
    });
    await ensureSessionIndexEntry(target, {
      sessionId: 'ses_x',
      sessionDir: '/abs/x-rerun',
      workDir: '/abs/wd',
    });
    const text = await readFile(join(target, 'session_index.jsonl'), 'utf-8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
  });

  it('appends only the missing entry when others are already present', async () => {
    await appendSessionIndexEntry(target, {
      sessionId: 'ses_a',
      sessionDir: '/abs/a',
      workDir: '/abs/wd',
    });
    await ensureSessionIndexEntry(target, {
      sessionId: 'ses_a',
      sessionDir: '/abs/a',
      workDir: '/abs/wd',
    });
    await ensureSessionIndexEntry(target, {
      sessionId: 'ses_b',
      sessionDir: '/abs/b',
      workDir: '/abs/wd',
    });
    const text = await readFile(join(target, 'session_index.jsonl'), 'utf-8');
    const ids = text
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l).sessionId);
    expect(ids).toEqual(['ses_a', 'ses_b']);
  });
});
