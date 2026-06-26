import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import { readSessionIndex } from '../../../src/session/store/session-index';

describe('readSessionIndex — archived flag', () => {
  let homeDir: string;

  afterEach(async () => {
    if (homeDir !== undefined) {
      await import('node:fs/promises').then((fs) => fs.rm(homeDir, { recursive: true, force: true }));
    }
  });

  it('preserves the archived flag on returned entries', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kc-index-'));
    const sessionId = 's-archived';
    const sessionsDir = join(homeDir, 'sessions');
    const sessionDir = join(sessionsDir, sessionId);
    const entry = {
      sessionId,
      sessionDir,
      workDir: '/repo',
      archived: true,
    };
    await writeFile(join(homeDir, 'session_index.jsonl'), `${JSON.stringify(entry)}\n`, 'utf-8');

    const index = await readSessionIndex(homeDir, sessionsDir);
    expect(index.get(sessionId)?.archived).toBe(true);
  });

  it('treats an absent archived flag as not archived', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kc-index-'));
    const sessionId = 's-active';
    const sessionsDir = join(homeDir, 'sessions');
    const sessionDir = join(sessionsDir, sessionId);
    const entry = { sessionId, sessionDir, workDir: '/repo' };
    await writeFile(join(homeDir, 'session_index.jsonl'), `${JSON.stringify(entry)}\n`, 'utf-8');

    const index = await readSessionIndex(homeDir, sessionsDir);
    expect(index.get(sessionId)?.archived).toBe(false);
  });
});
