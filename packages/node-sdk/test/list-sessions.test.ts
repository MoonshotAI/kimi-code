/**
 * Scenario: Node SDK sessions persist and list through the public harness.
 * Responsibilities: workDir scoping, native path-safe listing, and persisted
 * listing across close.
 * Wiring: real in-process harness/engine session storage; no remote provider
 * calls. (The legacy `SessionStore.list` unit cases lived on the retired
 * agent-core TS store and were dropped with the engine migration.)
 * Run: pnpm exec vitest run test/list-sessions.test.ts
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness } from '#/index';
import type { KimiError } from '#/index';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-list-'));
  tempDirs.push(dir);
  return dir;
}

describe('KimiHarness.listSessions', () => {
  it('rejects whitespace-only workDir with request.work_dir_required', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(harness.listSessions({ workDir: '   ' })).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.work_dir_required',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('lists all sessions when no payload is provided', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const otherWorkDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await harness.createSession({ id: 'ses_harness_all_a', workDir });
      await harness.createSession({ id: 'ses_harness_all_b', workDir: otherWorkDir });

      const sessions = await harness.listSessions();
      expect(sessions.map((session) => session.id).toSorted()).toEqual([
        'ses_harness_all_a',
        'ses_harness_all_b',
      ]);
    } finally {
      await harness.close();
    }
  });

  it('lists a session from a workDir containing spaces and non-ASCII characters', async () => {
    const homeDir = await makeTempDir();
    const root = await makeTempDir();
    const workDir = join(root, 'Workspace With Spaces', '项目');
    await mkdir(workDir, { recursive: true });
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_unicode_workdir', workDir });

      const sessions = await harness.listSessions({ workDir });
      expect(sessions.map((item) => item.id)).toEqual([session.id]);
    } finally {
      await harness.close();
    }
  });

  it('resolves relative workDir inputs before filtering', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });
    const originalCwd = process.cwd();

    try {
      process.chdir(workDir);
      const session = await harness.createSession({ id: 'ses_relative_workdir', workDir: '.' });

      const sessions = await harness.listSessions({ workDir: '.' });
      expect(sessions.map((item) => item.id)).toEqual([session.id]);
    } finally {
      process.chdir(originalCwd);
      await harness.close();
    }
  });

  it('lists persisted sessions after the active Session has been closed', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_closed_but_listed', workDir });
      await harness.closeSession(session.id);

      const sessions = await harness.listSessions({ workDir });
      expect(sessions.map((item) => item.id)).toEqual([session.id]);
    } finally {
      await harness.close();
    }
  });
});
