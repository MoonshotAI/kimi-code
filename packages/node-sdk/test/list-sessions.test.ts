import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness } from '#/index';
import type { KimiError } from '#/index';

import {
  SessionStore,
  encodeWorkDirKey,
  sessionIndexPath,
} from '../../agent-core/src/session/store';
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

async function writeSessionState(
  sessionDir: string,
  state: Record<string, unknown>,
): Promise<string> {
  const statePath = join(sessionDir, 'state.json');
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  return statePath;
}

describe('SessionStore.list', () => {
  it('returns an empty array when the workDir bucket does not exist', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    await expect(store.list({ workDir })).resolves.toEqual([]);
  });

  it('creates workDir-scoped session directories and a root session index', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    const summary = await store.create({ id: 'ses_list_full', workDir });

    expect(summary).toMatchObject({
      id: 'ses_list_full',
      workDir,
      title: undefined,
    });
    expect(summary.sessionDir).not.toBe(join(homeDir, 'sessions', 'ses_list_full'));
    expect(basename(summary.sessionDir)).toBe('ses_list_full');
    const workdirKey = basename(dirname(summary.sessionDir));
    expect(workdirKey).toBe(encodeWorkDirKey(workDir));
    expect(workdirKey.length).toBeLessThan(70);
    expect(existsSync(join(summary.sessionDir, 'state.json'))).toBe(false);

    const indexRaw = await readFile(sessionIndexPath(homeDir), 'utf-8');
    expect(indexRaw).toContain('"sessionId":"ses_list_full"');
    expect(indexRaw).toContain(summary.sessionDir);
    expect(indexRaw).toContain(`"workDir":"${workDir}"`);
  });

  it('forks a session directory, rewrites metadata, and drops reserved goal state', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    const source = await store.create({ id: 'ses_fork_source', workDir });
    const sourceAgentDir = join(source.sessionDir, 'agents', 'main');
    const sourceSubagentDir = join(source.sessionDir, 'agents', 'agent-1');
    await mkdir(sourceAgentDir, { recursive: true });
    await mkdir(sourceSubagentDir, { recursive: true });
    await writeFile(join(sourceAgentDir, 'wire.jsonl'), '{"type":"context.clear"}\n', 'utf-8');
    await writeFile(join(sourceSubagentDir, 'wire.jsonl'), '{"type":"context.clear"}\n', 'utf-8');
    await writeFile(
      join(source.sessionDir, 'upcoming-goals.json'),
      `${JSON.stringify({ version: 1, goals: [{ id: 'queued-1', objective: 'source queued goal' }] })}\n`,
      'utf-8',
    );
    await writeSessionState(source.sessionDir, {
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:00.000Z',
      title: 'Source title',
      isCustomTitle: true,
      agents: {
        main: {
          homedir: sourceAgentDir,
          type: 'main',
        },
        'agent-1': {
          homedir: sourceSubagentDir,
          type: 'subagent',
          parentAgentId: 'main',
        },
      },
      custom: {
        source: true,
        goal: {
          goalId: 'source-goal',
          objective: 'source objective',
          status: 'active',
          turnsUsed: 0,
          tokensUsed: 0,
          budgetLimits: {},
        },
      },
    });

    const fork = await store.fork({
      sourceId: source.id,
      targetId: 'ses_fork_child',
      title: 'Fork title',
      metadata: {
        child: true,
        goal: {
          goalId: 'metadata-goal',
          objective: 'metadata objective',
          status: 'active',
          turnsUsed: 0,
          tokensUsed: 0,
          budgetLimits: {},
        },
      },
    });

    const forkState = JSON.parse(await readFile(join(fork.sessionDir, 'state.json'), 'utf-8')) as {
      title?: string;
      isCustomTitle?: boolean;
      forkedFrom?: string;
      agents?: { main?: { homedir?: string } };
      custom?: Record<string, unknown>;
    };
    expect(forkState.title).toBe('Fork title');
    expect(forkState.isCustomTitle).toBe(true);
    expect(forkState.forkedFrom).toBe(source.id);
    expect(forkState.agents?.main?.homedir).toBe(join(fork.sessionDir, 'agents', 'main'));
    expect(forkState.custom).toMatchObject({ source: true, child: true });
    expect(forkState.custom).not.toHaveProperty('goal');
    expect(existsSync(join(fork.sessionDir, 'upcoming-goals.json'))).toBe(false);
    expect(existsSync(join(source.sessionDir, 'upcoming-goals.json'))).toBe(true);
    const forkWire = await readFile(join(fork.sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
    expect(forkWire
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      { type: 'context.clear' },
      { type: 'forked', time: expect.any(Number) },
    ]);
    const forkSubagentWire = await readFile(
      join(fork.sessionDir, 'agents', 'agent-1', 'wire.jsonl'),
      'utf-8',
    );
    expect(forkSubagentWire
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      { type: 'context.clear' },
      { type: 'forked', time: expect.any(Number) },
    ]);

    const sourceState = JSON.parse(
      await readFile(join(source.sessionDir, 'state.json'), 'utf-8'),
    ) as { forkedFrom?: string };
    expect(sourceState.forkedFrom).toBeUndefined();
    const sessions = await store.list({ workDir });
    expect(sessions.map((session) => session.id).toSorted()).toEqual([
      source.id,
      fork.id,
    ].toSorted());
  });

  it('returns only sessions from the requested workDir bucket', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const otherWorkDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    await store.create({ id: 'ses_list_a', workDir });
    await store.create({ id: 'ses_other_workdir', workDir: otherWorkDir });

    const sessions = await store.list({ workDir });
    expect(sessions.map((session) => session.id)).toEqual(['ses_list_a']);
  });

  it('uses the workDir bucket before the session index when sessionId is provided', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    const local = await store.create({ id: 'ses_bucket_hit', workDir });
    await rm(sessionIndexPath(homeDir), { force: true });

    const sessions = await store.list({ workDir, sessionId: local.id });
    expect(sessions.map((session) => session.id)).toEqual([local.id]);
  });

  it('falls back to the session index when a workDir-scoped sessionId is not in that bucket', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const otherWorkDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    await store.create({ id: 'ses_local', workDir });
    const other = await store.create({ id: 'ses_index_fallback', workDir: otherWorkDir });

    const sessions = await store.list({ workDir, sessionId: other.id });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: other.id,
      workDir: otherWorkDir,
    });
  });

  it('lists every indexed session when no filters are provided', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const otherWorkDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    await store.create({ id: 'ses_all_a', workDir });
    await store.create({ id: 'ses_all_b', workDir: otherWorkDir });

    const sessions = await store.list();
    expect(sessions.map((session) => session.id).toSorted()).toEqual([
      'ses_all_a',
      'ses_all_b',
    ]);
  });

  it('returns an empty array when a sessionId filter is unknown', async () => {
    const homeDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    await expect(store.list({ sessionId: 'ses_missing' })).resolves.toEqual([]);
  });

  it('reads title from customTitle before title', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    const custom = await store.create({ id: 'ses_custom_title', workDir });
    await writeSessionState(custom.sessionDir, {
      title: 'Base Title',
      customTitle: 'Custom Title',
    });
    const fallback = await store.create({ id: 'ses_fallback_title', workDir });
    await writeSessionState(fallback.sessionDir, {
      title: 'Fallback Title',
    });

    const sessions = await store.list({ workDir });
    expect(sessions.find((session) => session.id === custom.id)?.title).toBe('Custom Title');
    expect(sessions.find((session) => session.id === fallback.id)?.title).toBe('Fallback Title');
  });

  it('keeps sessions visible when state.json is missing or malformed', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    await store.create({ id: 'ses_no_state', workDir });
    const malformed = await store.create({ id: 'ses_bad_state', workDir });
    await writeFile(join(malformed.sessionDir, 'state.json'), '{bad json', 'utf-8');

    const sessions = await store.list({ workDir });
    expect(sessions.map((session) => session.id).toSorted()).toEqual([
      'ses_bad_state',
      'ses_no_state',
    ]);
    expect(sessions.every((session) => session.title === undefined)).toBe(true);
  });

  it('sorts by filesystem activity descending', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const store = new SessionStore(homeDir);

    const oldSession = await store.create({ id: 'ses_old', workDir });
    const newSession = await store.create({ id: 'ses_new', workDir });
    const oldTime = new Date('2030-04-18T12:00:00Z');
    const newTime = new Date('2030-04-18T12:00:10Z');
    await writeFile(join(oldSession.sessionDir, 'wire.jsonl'), '{}\n', 'utf-8');
    await writeFile(join(newSession.sessionDir, 'wire.jsonl'), '{}\n', 'utf-8');
    await utimes(join(oldSession.sessionDir, 'wire.jsonl'), oldTime, oldTime);
    await utimes(join(newSession.sessionDir, 'wire.jsonl'), newTime, newTime);

    const sessions = await store.list({ workDir });
    expect(sessions.map((session) => session.id)).toEqual(['ses_new', 'ses_old']);
  });

  it('does not scan legacy flat session directories', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    await mkdir(join(homeDir, 'sessions', 'ses_legacy_flat'), { recursive: true });
    await writeSessionState(join(homeDir, 'sessions', 'ses_legacy_flat'), {
      session_id: 'ses_legacy_flat',
      workspace_dir: workDir,
      custom_title: 'Legacy Flat',
    });

    const store = new SessionStore(homeDir);
    await expect(store.list({ workDir })).resolves.toEqual([]);
    await expect(store.get('ses_legacy_flat')).rejects.toMatchObject({
      name: 'KimiError',
      code: 'session.not_found',
    });
  });
});

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
