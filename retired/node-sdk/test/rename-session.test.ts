import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness, KimiError, type Event } from '#/index';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-rename-'));
  tempDirs.push(dir);
  return dir;
}

async function writeSessionState(
  sessionDir: string,
  state: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(sessionDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

async function readSessionState(sessionDir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(sessionDir, 'state.json'), 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function findRenamedEvent(
  events: readonly Event[],
): Extract<Event, { readonly type: 'session.meta.updated' }> {
  const event = events.find((item) => item.type === 'session.meta.updated');
  if (event === undefined || event.type !== 'session.meta.updated') {
    throw new Error('session_meta_updated event not found');
  }
  return event;
}

describe('KimiHarness.renameSession', () => {
  it('persists titles through the public Harness API and emits an active session event', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({
        id: 'ses_harness_rename',
        workDir,
      });
      const summary = (await harness.listSessions({ workDir })).find(
        (item) => item.id === session.id,
      )!;
      await writeSessionState(summary.sessionDir, {
        session_id: session.id,
        title: 'Base Title',
      });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      await harness.renameSession({ id: session.id, title: 'Harness Title' });
      unsubscribe();

      const sessions = await harness.listSessions({ workDir });
      expect(sessions.find((item) => item.id === session.id)?.title).toBe('Harness Title');

      const state = await readSessionState(summary.sessionDir);
      expect(state['title']).toBe('Harness Title');
      expect(state['isCustomTitle']).toBe(true);

      const event = findRenamedEvent(events);
      expect(event).toMatchObject({
        type: 'session.meta.updated',
        sessionId: session.id,
        agentId: 'main',
        title: 'Harness Title',
      });
    } finally {
      await harness.close();
    }
  });

  it('renames persisted sessions even when they are not active in memory', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_inactive_rename', workDir });
      const summary = (await harness.listSessions({ workDir })).find(
        (item) => item.id === session.id,
      )!;
      await writeSessionState(summary.sessionDir, {
        session_id: session.id,
        title: 'Inactive Base',
      });
      const events: Event[] = [];
      session.onEvent((event) => {
        events.push(event);
      });

      await harness.closeSession(session.id);
      events.length = 0;

      await harness.renameSession({ id: session.id, title: 'Inactive Title' });

      const sessions = await harness.listSessions({ workDir });
      expect(sessions.find((item) => item.id === session.id)?.title).toBe('Inactive Title');
      expect(events.some((event) => event.type === 'session.meta.updated')).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('rejects missing session ids', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const missingRename = harness.renameSession({
        id: 'ses_missing',
        title: 'Missing Title',
      });
      await expect(missingRename).rejects.toBeInstanceOf(KimiError);
      await expect(missingRename).rejects.toMatchObject({
        code: 'session.not_found',
        details: { sessionId: 'ses_missing' },
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });
});
