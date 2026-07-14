import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { basename as posixBasename } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Emitter } from '../../src';
import type { Event } from '@moonshot-ai/protocol';
import type { IEnvironmentService } from '../../src/services/environment/environment';
import type { IEventService } from '../../src/services/event/event';
import type { ILogService } from '../../src/services/logger/logger';
import { WorkspaceRegistryService } from '../../src/services/workspace/workspaceRegistryService';
import { appendSessionIndexEntry } from '../../src/session/store/session-index';
import { encodeWorkDirKey, normalizeWorkDir } from '../../src/session/store/workdir-key';

function makeLogger(): ILogService {
  const noop = (): void => {};
  return {
    _serviceBrand: undefined,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => makeLogger(),
  };
}

function makeEventService(): IEventService & { events: Event[] } {
  const emitter = new Emitter<Event>();
  const events: Event[] = [];
  return {
    _serviceBrand: undefined,
    events,
    onDidPublish: emitter.event,
    publish: (event: Event) => {
      events.push(event);
      emitter.fire(event);
    },
  };
}

interface TestContext {
  homeDir: string;
  registry: WorkspaceRegistryService;
}

describe('WorkspaceRegistryService', () => {
  let ctx: TestContext;
  let tempRoots: string[] = [];

  beforeEach(async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-ws-home-'));
    const env: IEnvironmentService = {
      _serviceBrand: undefined,
      homeDir,
      configPath: join(homeDir, 'config.toml'),
    };
    ctx = {
      homeDir,
      registry: new WorkspaceRegistryService(env, makeLogger(), makeEventService()),
    };
    tempRoots = [];
  });

  afterEach(async () => {
    await rm(ctx.homeDir, { recursive: true, force: true });
    for (const root of tempRoots) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function makeProjectRoot(label: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `kimi-ws-${label}-`));
    tempRoots.push(root);
    // Normalize to the canonical forward-slash form the registry stores
    // (via pathe), so `expect(roots).toContain(root)` holds on Windows too.
    // realpath first so symlinked tmpdir() (e.g. /tmp → /private/tmp on
    // macOS) still agrees with the workDir key.
    return normalizeWorkDir(await realpath(root));
  }

  async function seedSessionBucket(
    root: string,
    sessionId: string,
    opts?: { archived?: boolean },
  ): Promise<void> {
    const key = encodeWorkDirKey(root);
    const sessionDir = join(ctx.homeDir, 'sessions', key, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'state.json'),
      JSON.stringify({ archived: opts?.archived === true }),
      'utf-8',
    );
    await appendSessionIndexEntry(ctx.homeDir, {
      sessionId,
      sessionDir,
      workDir: root,
    });
  }

  it('auto-registers a workspace for a session bucket missing from the registry', async () => {
    const registeredRoot = await makeProjectRoot('reg');
    const derivedRoot = await makeProjectRoot('derived');

    await ctx.registry.createOrTouch(registeredRoot);
    // derivedRoot has a session bucket + index entry but is NOT registered.
    await seedSessionBucket(derivedRoot, 'sess-derived-1');

    const list = await ctx.registry.list();
    const roots = list.map((w) => w.root);

    expect(roots).toContain(registeredRoot);
    expect(roots).toContain(derivedRoot);

    const derived = list.find((w) => w.root === derivedRoot);
    expect(derived).toBeDefined();
    expect(derived?.session_count).toBe(1);
  });

  it('does not duplicate an already-registered workspace', async () => {
    const root = await makeProjectRoot('only');
    await ctx.registry.createOrTouch(root);
    // A bucket for the same root exists, but it is already registered.
    await seedSessionBucket(root, 'sess-only-1');

    const list = await ctx.registry.list();
    const matches = list.filter((w) => w.root === root);
    expect(matches).toHaveLength(1);
  });

  it('normalizes lexical root aliases to one canonical workspace', async () => {
    const root = await makeProjectRoot('normalized');
    const alias = join(root, '..', posixBasename(root));

    const created = await ctx.registry.createOrTouch(alias);

    expect(created.root).toBe(root);
    expect((await ctx.registry.list()).filter((workspace) => workspace.root === root)).toHaveLength(1);
  });

  it('serializes concurrent registry mutations across instances', async () => {
    const rootA = await makeProjectRoot('lock-a');
    const rootB = await makeProjectRoot('lock-b');
    const second = new WorkspaceRegistryService(
      {
        _serviceBrand: undefined,
        homeDir: ctx.homeDir,
        configPath: join(ctx.homeDir, 'config.toml'),
      },
      makeLogger(),
      makeEventService(),
    );
    const releaseExternal = await lockfile.lock(join(ctx.homeDir, 'workspaces.json'), {
      realpath: false,
    });
    let settled = false;
    const pending = Promise.all([
      ctx.registry.createOrTouch(rootA),
      second.createOrTouch(rootB),
    ]).then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    await releaseExternal();
    await pending;

    expect((await ctx.registry.list()).map((workspace) => workspace.root).toSorted()).toEqual(
      [rootA, rootB].toSorted(),
    );
    second.dispose();
  });

  it('keeps a derived bucket visible even when its root no longer exists on disk', async () => {
    const registeredRoot = await makeProjectRoot('live');
    await ctx.registry.createOrTouch(registeredRoot);

    // A session whose cwd has since been deleted: the bucket + index remain,
    // so the conversation should still show (matches the old global walk).
    const goneRoot = normalizeWorkDir(join(tmpdir(), 'kimi-ws-gone-never-created'));
    await seedSessionBucket(goneRoot, 'sess-gone-1');

    const list = await ctx.registry.list();
    const roots = list.map((w) => w.root);

    expect(roots).toContain(registeredRoot);
    expect(roots).toContain(goneRoot);
  });

  it('does not re-register a deleted workspace that still has sessions', async () => {
    const root = await makeProjectRoot('deleted');
    const ws = await ctx.registry.createOrTouch(root);
    // Session bucket + index entry remain on disk after the registry entry is removed.
    await seedSessionBucket(root, 'sess-del-1');

    await ctx.registry.delete(ws.id);

    const list = await ctx.registry.list();
    expect(list.map((w) => w.root)).not.toContain(root);
  });

  it('re-adding a previously deleted workspace clears its tombstone', async () => {
    const root = await makeProjectRoot('readd');
    const ws = await ctx.registry.createOrTouch(root);
    await seedSessionBucket(root, 'sess-readd-1');
    await ctx.registry.delete(ws.id);

    // Explicit re-add should bring it back (clears the tombstone).
    await ctx.registry.createOrTouch(root);

    const list = await ctx.registry.list();
    expect(list.map((w) => w.root)).toContain(root);
  });

  it('registers a derived workspace under the symlink bucket key, not the realpath', async () => {
    const realDir = await makeProjectRoot('real');
    const linkParent = await mkdtemp(join(tmpdir(), 'kimi-ws-link-'));
    tempRoots.push(linkParent);
    const linkDir = join(linkParent, 'link');
    await symlink(realDir, linkDir);

    // Seed a session bucket keyed by the SYMLINK path (resolve, not realpath),
    // matching how SessionStore keys cwd-only sessions created from a symlinked cwd.
    await seedSessionBucket(linkDir, 'sess-symlink-1');

    const list = await ctx.registry.list();
    const symlinkId = encodeWorkDirKey(linkDir);
    const derived = list.find((w) => w.id === symlinkId);

    // The workspace must be registered with the bucket key so per-workspace
    // session lookups read the same bucket the sessions live in.
    expect(derived).toBeDefined();
    expect(derived?.session_count).toBe(1);
  });

  it('does not register a derived bucket that only has archived sessions', async () => {
    const root = await makeProjectRoot('archived');
    await seedSessionBucket(root, 'sess-archived-1', { archived: true });

    const list = await ctx.registry.list();
    expect(list.map((w) => w.root)).not.toContain(root);
  });

  it('does not count an indexed session whose state document is missing', async () => {
    const root = await makeProjectRoot('missing-state');
    const workspace = await ctx.registry.createOrTouch(root);
    const sessionDir = join(ctx.homeDir, 'sessions', workspace.id, 'missing-state-session');
    await mkdir(sessionDir, { recursive: true });
    await appendSessionIndexEntry(ctx.homeDir, {
      sessionId: 'missing-state-session',
      sessionDir,
      workDir: root,
    });

    const listed = await ctx.registry.list();
    expect(listed.find((entry) => entry.id === workspace.id)?.session_count).toBe(0);
  });

  it('ignores indexed sessions without an absolute workDir', async () => {
    const sessionDir = join(ctx.homeDir, 'sessions', 'wd_invalid_000000000000', 'invalid-cwd');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({ archived: false }), 'utf8');
    await appendSessionIndexEntry(ctx.homeDir, {
      sessionId: 'invalid-cwd',
      sessionDir,
      workDir: '',
    });

    expect(await ctx.registry.list()).toEqual([]);
  });

  it('preserves an alias-only workspace id and its session bucket', async () => {
    const root = await makeProjectRoot('alias-only');
    const canonicalId = encodeWorkDirKey(root);
    const legacyId = 'wd_aliaslegacy_deadbeef0000';
    const registryPath = join(ctx.homeDir, 'workspaces.json');
    const entry = {
      root,
      name: 'alias-only',
      created_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
    };
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          version: 1,
          workspaces: { [legacyId]: entry },
          deleted_workspace_ids: [],
        },
        null,
        2,
      ),
      'utf-8',
    );

    const sessionDir = join(ctx.homeDir, 'sessions', legacyId, 'sess-alias-only');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({ archived: false }), 'utf-8');
    await appendSessionIndexEntry(ctx.homeDir, {
      sessionId: 'sess-alias-only',
      sessionDir,
      workDir: root,
    });

    const listed = await ctx.registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: legacyId, session_count: 1 });

    // A canonical lookup may fall back to the root, but must return the real
    // representative id so subsequent session queries use the populated alias
    // bucket rather than an empty canonical bucket.
    await expect(ctx.registry.get(canonicalId)).resolves.toMatchObject({
      id: legacyId,
      session_count: 1,
    });
    await expect(ctx.registry.createOrTouch(root)).resolves.toMatchObject({
      id: legacyId,
      session_count: 1,
    });
    await expect(ctx.registry.update(legacyId, { name: 'renamed' })).resolves.toMatchObject({
      id: legacyId,
      session_count: 1,
    });
  });

  it('tombstones a derived workspace on delete so it stays removed', async () => {
    const root = await makeProjectRoot('derived-del');
    // Derived (cwd-only, never registered) workspace with an active session.
    await seedSessionBucket(root, 'sess-ddel-1');
    const derivedId = encodeWorkDirKey(root);

    expect((await ctx.registry.list()).map((w) => w.id)).toContain(derivedId);

    await ctx.registry.delete(derivedId);

    expect((await ctx.registry.list()).map((w) => w.id)).not.toContain(derivedId);
  });

  it('uses the canonical bucket count across duplicate-root registry responses', async () => {
    const root = await makeProjectRoot('dup');
    const canonicalId = encodeWorkDirKey(root);
    // Simulate a registry that also holds a legacy id for the same folder (e.g.
    // one produced by an older, realpath-based encodeWorkDirKey on Windows).
    const legacyId = 'wd_duplegacy_deadbeef0000';
    const registryPath = join(ctx.homeDir, 'workspaces.json');
    const entry = { root, name: 'dup', created_at: '2026-01-01T00:00:00.000Z', last_opened_at: '2026-01-01T00:00:00.000Z' };
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          version: 1,
          // Legacy first so the canonical entry must actively replace it.
          workspaces: { [legacyId]: entry, [canonicalId]: entry },
          deleted_workspace_ids: [],
        },
        null,
        2,
      ),
      'utf-8',
    );
    // One active session in the canonical bucket (via the index)...
    await seedSessionBucket(root, 'sess-canonical-1');
    // ...and one stranded in the legacy bucket. Root-based session queries
    // include both buckets, so the workspace count does too.
    const legacySessionDir = join(ctx.homeDir, 'sessions', legacyId, 'sess-legacy-1');
    await mkdir(legacySessionDir, { recursive: true });
    await writeFile(
      join(legacySessionDir, 'state.json'),
      JSON.stringify({ archived: false }),
      'utf-8',
    );
    await appendSessionIndexEntry(ctx.homeDir, {
      sessionId: 'sess-legacy-1',
      sessionDir: legacySessionDir,
      workDir: root,
    });

    const list = await ctx.registry.list();
    const matches = list.filter((w) => w.root === root);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe(canonicalId);
    expect(matches[0]?.session_count).toBe(2);

    expect((await ctx.registry.get(canonicalId)).session_count).toBe(2);
    expect((await ctx.registry.get(legacyId)).id).toBe(canonicalId);
    expect((await ctx.registry.createOrTouch(root)).session_count).toBe(2);
    expect((await ctx.registry.update(canonicalId, { name: 'renamed' })).session_count).toBe(2);
  });
});
