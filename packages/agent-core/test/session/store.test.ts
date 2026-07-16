/**
 * Scenario: persisted sessions remain addressable across native path forms.
 * Responsibilities: create/list/index behavior plus Windows drive and UNC workDir normalization.
 * Wiring: real temporary session storage; no stubbed collaborators.
 * Run: pnpm exec vitest run test/session/store.test.ts
 */
import { mkdtemp, mkdir, realpath, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionStore } from '../../src/session/store/session-store';
import {
  appendSessionIndexDeletion,
  appendSessionIndexEntry,
  readSessionIndex,
} from '../../src/session/store/session-index';
import { encodeWorkDirKey, normalizeWorkDir } from '../../src/session/store/workdir-key';

async function makeWorkDir(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `kimi-store-wd-${label}-`));
  // realpath so a symlinked tmpdir (e.g. /tmp -> /private/tmp on macOS) agrees
  // with the workDir key used by the store.
  return normalizeWorkDir(await realpath(root));
}

async function seedSessionDir(
  homeDir: string,
  workDir: string,
  sessionId: string,
  state: Record<string, unknown> = {},
): Promise<string> {
  const dir = join(homeDir, 'sessions', encodeWorkDirKey(workDir), sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify({ workDir, ...state }), 'utf-8');
  return dir;
}

describe('SessionStore', () => {
  let homeDir: string;
  let store: SessionStore;
  const tempRoots: string[] = [];

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-store-home-'));
    store = new SessionStore(homeDir);
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
    for (const root of tempRoots) {
      await rm(root, { recursive: true, force: true });
    }
    tempRoots.length = 0;
  });

  async function trackWorkDir(label: string): Promise<string> {
    const wd = await makeWorkDir(label);
    tempRoots.push(wd);
    return wd;
  }

  describe('create', () => {
    it('creates a session when an earlier index entry points to a missing directory', async () => {
      const workDir = await trackWorkDir('stale-create');
      const sessionId = 'session_stale_create';
      await appendSessionIndexEntry(homeDir, {
        sessionId,
        sessionDir: join(homeDir, 'sessions', 'wd_stale_000000000000', sessionId),
        workDir,
      });

      await expect(store.create({ id: sessionId, workDir })).resolves.toMatchObject({
        id: sessionId,
        workDir,
      });
    });

    it('returns a canonical drive workDir when Windows separators are used', async () => {
      const summary = await store.create({
        id: 'session_windows_drive',
        workDir: 'C:\\Users\\Example User\\项目',
      });

      expect(summary.workDir).toBe('C:/Users/Example User/项目');
    });

    it('preserves the share root when an UNC workDir is used', async () => {
      const summary = await store.create({
        id: 'session_windows_unc',
        workDir: '\\\\Server\\Share\\Workspace\\项目',
      });

      expect(summary.workDir).toBe('//Server/Share/Workspace/项目');
    });
  });

  describe('summaryFromDir (via get/list)', () => {
    it('prefers workDir from state.json over the index entry', async () => {
      const indexWorkDir = await trackWorkDir('index');
      const stateWorkDir = await trackWorkDir('state');
      const sessionId = 'session_pref';

      // Index says one workDir; state.json (self-describing) says another.
      await store.create({ id: sessionId, workDir: indexWorkDir });
      const dir = join(homeDir, 'sessions', encodeWorkDirKey(indexWorkDir), sessionId);
      await writeFile(join(dir, 'state.json'), JSON.stringify({ workDir: stateWorkDir }), 'utf-8');

      const summary = await store.get(sessionId);
      expect(summary.workDir).toBe(stateWorkDir);
    });
  });

  describe('list by Windows workDir', () => {
    it('merges drive buckets when only workDir casing differs', async () => {
      await store.create({ id: 'session_drive_upper', workDir: 'C:\\Workspace\\项目' });
      await store.create({ id: 'session_drive_lower', workDir: 'c:\\workspace\\项目' });

      const sessions = await store.list({ workDir: 'C:/WORKSPACE/项目' });

      expect(sessions.map((session) => session.id).toSorted()).toEqual([
        'session_drive_lower',
        'session_drive_upper',
      ]);
    });

    it('merges UNC buckets when server and share casing differs', async () => {
      await store.create({
        id: 'session_unc_upper',
        workDir: '\\\\Server\\Share\\Workspace',
      });
      await store.create({
        id: 'session_unc_lower',
        workDir: '\\\\server\\share\\workspace',
      });

      const sessions = await store.list({ workDir: '//SERVER/SHARE/WORKSPACE' });

      expect(sessions.map((session) => session.id).toSorted()).toEqual([
        'session_unc_lower',
        'session_unc_upper',
      ]);
    });
  });

  describe('reindex', () => {
    it('adds an index entry for an on-disk session missing from the index', async () => {
      const workDir = await trackWorkDir('missing');
      const sessionId = 'session_missing';
      await seedSessionDir(homeDir, workDir, sessionId);

      expect(await store.list({})).toHaveLength(0);

      const stats = await store.reindex();
      expect(stats).toEqual({ scanned: 1, added: 1, repaired: 0 });

      const listed = await store.list({});
      expect(listed.map((s) => s.id)).toEqual([sessionId]);
      expect(listed[0]?.workDir).toBe(workDir);
    });

    it('repairs an index entry that points at a stale sessionDir', async () => {
      const workDir = await trackWorkDir('stale');
      const sessionId = 'session_stale';
      const realDir = await seedSessionDir(homeDir, workDir, sessionId);

      // Seed a decoy dir inside the sessions tree with a matching basename so it
      // passes index integrity checks, then point the index at it instead of the
      // real dir.
      const decoyDir = join(homeDir, 'sessions', 'wd_decoy_000000000000', sessionId);
      await mkdir(decoyDir, { recursive: true });
      await appendSessionIndexEntry(homeDir, {
        sessionId,
        sessionDir: decoyDir,
        workDir,
      });

      const stats = await store.reindex();
      expect(stats).toEqual({ scanned: 1, added: 0, repaired: 1 });

      const index = await readSessionIndex(homeDir, store.sessionsDir);
      expect(index.get(sessionId)?.sessionDir).toBe(realDir);
    });

    it('repairs an index entry whose sessionDir is correct but workDir is stale', async () => {
      const workDir = await trackWorkDir('staleworkdir');
      const sessionId = 'session_staleworkdir';
      // Legacy state: no top-level workDir, only custom.cwd, so summaryFromDir
      // falls back to the index entry's workDir.
      const realDir = join(homeDir, 'sessions', encodeWorkDirKey(workDir), sessionId);
      await mkdir(realDir, { recursive: true });
      await writeFile(
        join(realDir, 'state.json'),
        JSON.stringify({ custom: { cwd: workDir } }),
        'utf-8',
      );

      // Index points at the right dir but carries a bogus workDir.
      await appendSessionIndexEntry(homeDir, {
        sessionId,
        sessionDir: realDir,
        workDir: '/totally/bogus/path',
      });

      // Before reindex the summary surfaces the bogus index workDir.
      expect((await store.get(sessionId)).workDir).toBe('/totally/bogus/path');

      const stats = await store.reindex();
      expect(stats).toEqual({ scanned: 1, added: 0, repaired: 1 });

      // Reindex appended a corrected line, so the summary now uses the recovered
      // workDir instead of the stale index value.
      expect((await store.get(sessionId)).workDir).toBe(workDir);
    });

    it('leaves a session unindexed when it records no recoverable workDir', async () => {
      const workDir = await trackWorkDir('noworkdir');
      const sessionId = 'session_noworkdir';
      // state.json present but without workDir or custom.cwd.
      await seedSessionDir(homeDir, workDir, sessionId, { workDir: undefined });
      // Overwrite state.json to truly drop the workDir field seedSessionDir adds.
      const dir = join(homeDir, 'sessions', encodeWorkDirKey(workDir), sessionId);
      await writeFile(join(dir, 'state.json'), JSON.stringify({ title: 'legacy' }), 'utf-8');

      const stats = await store.reindex();
      expect(stats).toEqual({ scanned: 0, added: 0, repaired: 0 });
      expect(await store.list({})).toHaveLength(0);
    });
  });

  describe('readSessionIndex', () => {
    it('keeps an entry whose index workDir is non-absolute, using state.json workDir', async () => {
      const workDir = await trackWorkDir('relaxed');
      const sessionId = 'session_relaxed';
      await seedSessionDir(homeDir, workDir, sessionId);

      const sessionDir = join(homeDir, 'sessions', encodeWorkDirKey(workDir), sessionId);
      // Non-absolute, previously would have dropped the entry.
      await appendSessionIndexEntry(homeDir, {
        sessionId,
        sessionDir,
        workDir: 'not/an/absolute/path',
      });

      const listed = await store.list({});
      expect(listed.map((s) => s.id)).toEqual([sessionId]);
      // state.json wins, so the bogus index workDir never surfaces.
      expect(listed[0]?.workDir).toBe(workDir);
    });

    it('removes an entry when a deletion record follows it', async () => {
      const workDir = await trackWorkDir('deleted-index');
      const sessionId = 'session_deleted_index';
      const sessionDir = await seedSessionDir(homeDir, workDir, sessionId);
      await appendSessionIndexEntry(homeDir, { sessionId, sessionDir, workDir });

      await appendSessionIndexDeletion(homeDir, sessionId);

      expect((await readSessionIndex(homeDir, store.sessionsDir)).has(sessionId)).toBe(false);
    });

    it('restores an id when a live entry follows its deletion record', async () => {
      const workDir = await trackWorkDir('restored-index');
      const sessionId = 'session_restored_index';
      const sessionDir = await seedSessionDir(homeDir, workDir, sessionId);
      const entry = { sessionId, sessionDir, workDir };
      await appendSessionIndexEntry(homeDir, entry);
      await appendSessionIndexDeletion(homeDir, sessionId);

      await appendSessionIndexEntry(homeDir, entry);

      expect((await readSessionIndex(homeDir, store.sessionsDir)).get(sessionId)).toEqual(entry);
    });
  });

  describe('delete', () => {
    it('removes the session directory and adds a deletion record to the index', async () => {
      const workDir = await trackWorkDir('delete-me');
      const sessionId = 'session_delete_me';
      await store.create({ id: sessionId, workDir });

      expect((await store.list({})).some((s) => s.id === sessionId)).toBe(true);

      const beforeDir = join(homeDir, 'sessions', encodeWorkDirKey(workDir), sessionId);
      const dirExistsBefore = await access(beforeDir).then(() => true, () => false);
      expect(dirExistsBefore).toBe(true);

      await store.delete(sessionId);

      const afterList = await store.list({});
      expect(afterList.some((s) => s.id === sessionId)).toBe(false);
      const dirExistsAfter = await access(beforeDir).then(() => true, () => false);
      expect(dirExistsAfter).toBe(false);
    });

    it('returns false when deleting a non-existent session', async () => {
      const result = await store.delete('session_nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('list edge cases', () => {
    it('returns an empty list when there are no sessions', async () => {
      const sessions = await store.list({});
      expect(sessions).toEqual([]);
    });

    it('filters by workDir correctly with special characters', async () => {
      const workDir = await trackWorkDir('special');
      await store.create({ id: 'session_special', workDir: join(workDir, '项目 (1)') });

      const sessions = await store.list({ workDir: join(workDir, '项目 (1)') });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe('session_special');
    });
  });
});
