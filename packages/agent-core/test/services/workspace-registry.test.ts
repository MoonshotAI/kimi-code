import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Emitter } from '../../src';
import type { Event } from '@moonshot-ai/protocol';
import type { IEnvironmentService } from '../../src/services/environment/environment';
import type { IEventService } from '../../src/services/event/event';
import type { ILogService } from '../../src/services/logger/logger';
import {
  WorkspaceRegistryService,
  findRegisteredIdByRootKey,
} from '../../src/services/workspace/workspaceRegistryService';
import { touchWorkspaceRegistry } from '../../src/session/store/workspace-registry-file';
import { appendSessionIndexEntry } from '../../src/session/store/session-index';
import { encodeWorkDirKey, normalizeWorkDir, workspaceRootKey } from '../../src/session/store/workdir-key';

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

  it('tombstones a derived workspace on delete so it stays removed', async () => {
    const root = await makeProjectRoot('derived-del');
    // Derived (cwd-only, never registered) workspace with an active session.
    await seedSessionBucket(root, 'sess-ddel-1');
    const derivedId = encodeWorkDirKey(root);

    expect((await ctx.registry.list()).map((w) => w.id)).toContain(derivedId);

    await ctx.registry.delete(derivedId);

    expect((await ctx.registry.list()).map((w) => w.id)).not.toContain(derivedId);
  });

  it('collapses duplicate registered entries for the same root, preferring the canonical id', async () => {
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
    // ...and one stranded in the legacy bucket. Both count: the session list
    // for a workspace id pages the UNION of the root's alias buckets, so the
    // count aggregates the same set the list can retrieve.
    const legacySessionDir = join(ctx.homeDir, 'sessions', legacyId, 'sess-legacy-1');
    await mkdir(legacySessionDir, { recursive: true });
    await writeFile(
      join(legacySessionDir, 'state.json'),
      JSON.stringify({ archived: false }),
      'utf-8',
    );

    const list = await ctx.registry.list();
    const matches = list.filter((w) => w.root === root);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe(canonicalId);
    // Count spans every alias bucket for the root (canonical + legacy).
    expect(matches[0]?.session_count).toBe(2);
  });

  it('merges registered entries whose roots differ only by drive-letter casing', async () => {
    // Pure file state — Windows-shaped roots are never touched as fs paths, so
    // this runs on any host. Two entries for one physical folder: the user's
    // typed casing and the disk's real casing.
    const typedId = 'wd_typed_deadbeef0000';
    const diskId = 'wd_disk_0123456789ab';
    const registryPath = join(ctx.homeDir, 'workspaces.json');
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          version: 1,
          workspaces: {
            [typedId]: { root: 'C:\\Users\\Dev\\Project', name: 'typed', created_at: '2026-01-01T00:00:00.000Z', last_opened_at: '2026-01-01T00:00:00.000Z' },
            [diskId]: { root: 'c:\\users\\dev\\project', name: 'disk', created_at: '2026-01-02T00:00:00.000Z', last_opened_at: '2026-01-02T00:00:00.000Z' },
          },
          deleted_workspace_ids: [],
        },
        null,
        2,
      ),
      'utf-8',
    );

    const list = await ctx.registry.list();
    const matches = list.filter((w) => w.name === 'typed' || w.name === 'disk');
    expect(matches).toHaveLength(1);
    // Neither fixture id is the canonical mint for these roots, so the first
    // entry in file order stands as the representative.
    expect(matches[0]?.id).toBe(typedId);
    expect(matches[0]?.root).toBe('C:\\Users\\Dev\\Project');
  });

  it('keeps POSIX registered entries with case-variant roots distinct', async () => {
    const upperId = 'wd_upper_deadbeef0000';
    const lowerId = 'wd_lower_0123456789ab';
    const registryPath = join(ctx.homeDir, 'workspaces.json');
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          version: 1,
          workspaces: {
            [upperId]: { root: '/Home/Dev/Project', name: 'upper', created_at: '2026-01-01T00:00:00.000Z', last_opened_at: '2026-01-01T00:00:00.000Z' },
            [lowerId]: { root: '/home/dev/project', name: 'lower', created_at: '2026-01-02T00:00:00.000Z', last_opened_at: '2026-01-02T00:00:00.000Z' },
          },
          deleted_workspace_ids: [],
        },
        null,
        2,
      ),
      'utf-8',
    );

    const list = await ctx.registry.list();
    const matches = list.filter((w) => w.name === 'upper' || w.name === 'lower');
    expect(matches).toHaveLength(2);
  });

  it('does not surface a derived workspace whose index workDir identity-matches a registered root', async () => {
    // The registered root and the session's recorded workDir are case variants
    // of one Windows directory; the bucket/index are keyed by hash strings, so
    // no Windows-shaped string touches the fs.
    const registeredId = 'wd_regalias_deadbeef0000';
    const registryPath = join(ctx.homeDir, 'workspaces.json');
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          version: 1,
          workspaces: {
            [registeredId]: { root: 'C:\\Users\\Dev\\CaseProj', name: 'caseproj', created_at: '2026-01-01T00:00:00.000Z', last_opened_at: '2026-01-01T00:00:00.000Z' },
          },
          deleted_workspace_ids: [],
        },
        null,
        2,
      ),
      'utf-8',
    );
    // A session bucket + index entry keyed by the lowercase variant — without
    // identity-aware skipping this resurfaces as a second, derived workspace.
    await seedSessionBucket('c:\\users\\dev\\caseproj', 'sess-case-1');

    const list = await ctx.registry.list();
    expect(list.filter((w) => w.id === registeredId)).toHaveLength(1);
    expect(list.some((w) => w.root === 'c:\\users\\dev\\caseproj')).toBe(false);
  });

  it('findWorkspaceIdByRoot returns the registered id for a case variant of a Windows root', async () => {
    const legacyId = 'wd_legacy_deadbeef0000';
    const registryPath = join(ctx.homeDir, 'workspaces.json');
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          version: 1,
          workspaces: {
            [legacyId]: { root: 'C:\\Users\\Dev\\Project', name: 'legacy', created_at: '2026-01-01T00:00:00.000Z', last_opened_at: '2026-01-01T00:00:00.000Z' },
          },
          deleted_workspace_ids: [],
        },
        null,
        2,
      ),
      'utf-8',
    );

    await expect(
      ctx.registry.findWorkspaceIdByRoot('c:\\users\\dev\\project'),
    ).resolves.toBe(legacyId);
    await expect(
      ctx.registry.findWorkspaceIdByRoot('/unrelated/path'),
    ).resolves.toBeUndefined();
  });

  it('resolveAliasWorkDirs folds registered pairs and index-only spellings of one Windows root', async () => {
    // Two registered entries for the same folder (case variants) plus a third
    // spelling that only exists in the session index — the split legacy bucket
    // was never registered.
    const typedId = 'wd_typed_deadbeef0000';
    const diskId = 'wd_disk_0123456789ab';
    const registryPath = join(ctx.homeDir, 'workspaces.json');
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          version: 1,
          workspaces: {
            [typedId]: { root: 'C:\\Users\\Dev\\Project', name: 'typed', created_at: '2026-01-01T00:00:00.000Z', last_opened_at: '2026-01-01T00:00:00.000Z' },
            [diskId]: { root: 'c:\\users\\dev\\project', name: 'disk', created_at: '2026-01-02T00:00:00.000Z', last_opened_at: '2026-01-02T00:00:00.000Z' },
          },
          deleted_workspace_ids: [],
        },
        null,
        2,
      ),
      'utf-8',
    );
    await seedSessionBucket('C:/users/dev/project', 'sess-alias-1');
    // An unrelated session/workDir must not leak into the alias set.
    await seedSessionBucket('D:\\other\\place', 'sess-alias-other');

    const expected = ['C:\\Users\\Dev\\Project', 'c:\\users\\dev\\project', 'C:/users/dev/project'];
    for (const id of [typedId, diskId]) {
      const aliases = await ctx.registry.resolveAliasWorkDirs(id);
      expect(new Set(aliases)).toEqual(new Set(expected));
      // Deterministic order (sorted).
      expect(aliases).toEqual([...expected].toSorted());
    }

    // A derived id (index-only bucket key) resolves its aliases the same way.
    const derivedAliases = await ctx.registry.resolveAliasWorkDirs(
      encodeWorkDirKey('C:/users/dev/project'),
    );
    expect(new Set(derivedAliases)).toEqual(new Set(expected));
  });

  it('resolveAliasWorkDirs returns [] for an id unknown to registry and index', async () => {
    await expect(ctx.registry.resolveAliasWorkDirs('wd_unknown_deadbeef0000')).resolves.toEqual([]);
  });

  it('resolveAliasWorkDirs keeps POSIX case variants distinct (singleton)', async () => {
    const upperId = 'wd_upper_deadbeef0000';
    const lowerId = 'wd_lower_0123456789ab';
    const registryPath = join(ctx.homeDir, 'workspaces.json');
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          version: 1,
          workspaces: {
            [upperId]: { root: '/Home/Dev/Project', name: 'upper', created_at: '2026-01-01T00:00:00.000Z', last_opened_at: '2026-01-01T00:00:00.000Z' },
            [lowerId]: { root: '/home/dev/project', name: 'lower', created_at: '2026-01-02T00:00:00.000Z', last_opened_at: '2026-01-02T00:00:00.000Z' },
          },
          deleted_workspace_ids: [],
        },
        null,
        2,
      ),
      'utf-8',
    );

    // POSIX paths never fold: each id resolves to its own root only.
    await expect(ctx.registry.resolveAliasWorkDirs(upperId)).resolves.toEqual(['/Home/Dev/Project']);
    await expect(ctx.registry.resolveAliasWorkDirs(lowerId)).resolves.toEqual(['/home/dev/project']);
  });

  it('delete removes and tombstones every folded alias of a Windows root', async () => {
    // Split legacy state: two registered spellings of one Windows root, plus a
    // third spelling remembered only by the session index.
    const typedRoot = 'C:\\Users\\Del\\Proj';
    const typedId = encodeWorkDirKey(normalizeWorkDir(typedRoot));
    const aliasRoot = 'c:\\users\\del\\proj';
    const aliasId = encodeWorkDirKey(normalizeWorkDir(aliasRoot));
    const indexOnlyRoot = 'C:/users/del/proj';
    await writeFile(
      join(ctx.homeDir, 'workspaces.json'),
      JSON.stringify({
        version: 1,
        workspaces: {
          [typedId]: { root: typedRoot, name: 'proj', created_at: 'x', last_opened_at: 'x' },
          [aliasId]: { root: aliasRoot, name: 'proj', created_at: 'x', last_opened_at: 'x' },
        },
        deleted_workspace_ids: [],
      }),
      'utf-8',
    );
    await appendSessionIndexEntry(ctx.homeDir, {
      sessionId: 's1',
      sessionDir: join(ctx.homeDir, 'sessions', encodeWorkDirKey(indexOnlyRoot), 's1'),
      workDir: indexOnlyRoot,
    });

    await ctx.registry.delete(typedId);

    await expect(ctx.registry.list()).resolves.toEqual([]);
    const file = JSON.parse(await readFile(join(ctx.homeDir, 'workspaces.json'), 'utf-8')) as {
      workspaces: Record<string, unknown>;
      deleted_workspace_ids: string[];
    };
    expect(Object.keys(file.workspaces)).toEqual([]);
    const expectedTombstones = new Set([typedId, aliasId]);
    expectedTombstones.add(encodeWorkDirKey(indexOnlyRoot));
    expectedTombstones.add(encodeWorkDirKey(normalizeWorkDir(indexOnlyRoot)));
    expect(new Set(file.deleted_workspace_ids)).toEqual(expectedTombstones);
    // Nothing left to resolve the directory through — no resurrection path.
    await expect(ctx.registry.resolveRoot(typedId)).rejects.toThrow();
  });

  it('session_count sums active sessions across alias buckets for one Windows root', async () => {
    // One registered root; sessions are split between the registered id's own
    // bucket (resolved-era placement) and a second bucket minted from a case
    // variant of the root (pre-resolver legacy split, never registered).
    const registeredId = 'wd_sum_deadbeef0000';
    const registryPath = join(ctx.homeDir, 'workspaces.json');
    await writeFile(
      registryPath,
      JSON.stringify(
        {
          version: 1,
          workspaces: {
            [registeredId]: { root: 'C:\\Users\\Dev\\SumProj', name: 'sumproj', created_at: '2026-01-01T00:00:00.000Z', last_opened_at: '2026-01-01T00:00:00.000Z' },
          },
          deleted_workspace_ids: [],
        },
        null,
        2,
      ),
      'utf-8',
    );
    // Active session in the registered bucket (not indexed — bucket counts do
    // not consult the index).
    const registeredSessionDir = join(ctx.homeDir, 'sessions', registeredId, 'sess-sum-1');
    await mkdir(registeredSessionDir, { recursive: true });
    await writeFile(
      join(registeredSessionDir, 'state.json'),
      JSON.stringify({ archived: false }),
      'utf-8',
    );
    // One active + one archived session in the split, index-only bucket.
    await seedSessionBucket('c:\\users\\dev\\sumproj', 'sess-sum-2');
    await seedSessionBucket('c:\\users\\dev\\sumproj', 'sess-sum-3', { archived: true });

    expect((await ctx.registry.get(registeredId)).session_count).toBe(2);
    const listed = (await ctx.registry.list()).find((w) => w.id === registeredId);
    expect(listed?.session_count).toBe(2);
  });
});

describe('findRegisteredIdByRootKey', () => {
  const entry = (root: string) => ({
    root,
    name: 'x',
    created_at: '2026-01-01T00:00:00.000Z',
    last_opened_at: '2026-01-01T00:00:00.000Z',
  });

  it('matches a case/slash variant of a registered Windows-shaped root', () => {
    const hit = findRegisteredIdByRootKey(
      { wd_a_deadbeef0000: entry('C:\\Users\\Dev\\Project') },
      workspaceRootKey('c:/users/dev/project'),
    );
    expect(hit).toBe('wd_a_deadbeef0000');
  });

  it('returns undefined when nothing identity-matches', () => {
    expect(
      findRegisteredIdByRootKey(
        { wd_a_deadbeef0000: entry('/home/dev') },
        workspaceRootKey('/home/other'),
      ),
    ).toBeUndefined();
  });

  it('keeps POSIX case variants distinct (POSIX paths never fold)', () => {
    expect(
      findRegisteredIdByRootKey(
        { wd_a_deadbeef0000: entry('/Home/Dev/Project') },
        workspaceRootKey('/home/dev/project'),
      ),
    ).toBeUndefined();
  });

  it('prefers preferredId over file order when several entries identity-match', () => {
    const workspaces = {
      wd_legacy_deadbeef0000: entry('C:\\Users\\Dev\\Project'),
      wd_canonical_0123456789ab: entry('c:\\users\\dev\\project'),
    };
    expect(
      findRegisteredIdByRootKey(
        workspaces,
        workspaceRootKey('C:/Users/Dev/Project'),
        'wd_canonical_0123456789ab',
      ),
    ).toBe('wd_canonical_0123456789ab');
    // Without a preference the first entry in file order wins.
    expect(findRegisteredIdByRootKey(workspaces, workspaceRootKey('C:/Users/Dev/Project'))).toBe(
      'wd_legacy_deadbeef0000',
    );
  });
});

describe('touchWorkspaceRegistry', () => {
  let homeDir: string;
  let tempRoots: string[] = [];

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-ws-touch-home-'));
    tempRoots = [];
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
    for (const root of tempRoots) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function makeProjectRoot(label: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `kimi-ws-touch-${label}-`));
    tempRoots.push(root);
    return normalizeWorkDir(await realpath(root));
  }

  async function readRegistryFile(): Promise<{
    version: number;
    workspaces: Record<
      string,
      { root: string; name: string; created_at: string; last_opened_at: string }
    >;
    deleted_workspace_ids: string[];
  }> {
    return JSON.parse(await readFile(join(homeDir, 'workspaces.json'), 'utf-8')) as never;
  }

  it('creates a new entry in workspaces.json', async () => {
    const root = await makeProjectRoot('new');

    const result = await touchWorkspaceRegistry(homeDir, root);

    expect(result.created).toBe(true);
    expect(result.workspaceId).toBe(encodeWorkDirKey(root));
    const file = await readRegistryFile();
    const entry = file.workspaces[result.workspaceId];
    expect(entry).toBeDefined();
    expect(entry?.root).toBe(root);
    expect(entry?.name).toBe(root.split('/').pop());
    expect(entry?.created_at).not.toBe('');
    expect(file.deleted_workspace_ids).toEqual([]);
  });

  it('touches an existing entry without resetting its name or created_at', async () => {
    const root = await makeProjectRoot('touch');
    const first = await touchWorkspaceRegistry(homeDir, root, 'custom-name');
    const before = (await readRegistryFile()).workspaces[first.workspaceId];
    expect(before?.name).toBe('custom-name');

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await touchWorkspaceRegistry(homeDir, root);

    expect(second.created).toBe(false);
    const after = (await readRegistryFile()).workspaces[first.workspaceId];
    expect(after?.name).toBe('custom-name');
    expect(after?.created_at).toBe(before?.created_at);
    expect(Date.parse(after?.last_opened_at ?? '')).toBeGreaterThan(
      Date.parse(before?.last_opened_at ?? ''),
    );
  });

  it('clears the deletion tombstone for the touched workspace', async () => {
    const root = await makeProjectRoot('tombstone');
    const workspaceId = encodeWorkDirKey(root);
    await writeFile(
      join(homeDir, 'workspaces.json'),
      JSON.stringify({ version: 1, workspaces: {}, deleted_workspace_ids: [workspaceId] }),
      'utf-8',
    );

    await touchWorkspaceRegistry(homeDir, root);

    const file = await readRegistryFile();
    expect(file.deleted_workspace_ids).toEqual([]);
    expect(file.workspaces[workspaceId]).toBeDefined();
  });

  it('recovers from a malformed workspaces.json', async () => {
    await writeFile(join(homeDir, 'workspaces.json'), '{ not json', 'utf-8');
    const root = await makeProjectRoot('malformed');

    const result = await touchWorkspaceRegistry(homeDir, root);

    const file = await readRegistryFile();
    expect(file.workspaces[result.workspaceId]?.root).toBe(root);
  });

  it('folds a Windows case-variant spelling onto the existing entry instead of minting a duplicate', async () => {
    // The runtime touch path must mirror the service's identity folding:
    // minting the alias id here would make it the preferred id on the next
    // `resolveWorkspaceId` call and split sessions into the duplicate bucket.
    const diskSpelling = 'C:\\Users\\Foo\\Proj';
    const diskId = encodeWorkDirKey(normalizeWorkDir(diskSpelling));
    await writeFile(
      join(homeDir, 'workspaces.json'),
      JSON.stringify({
        version: 1,
        workspaces: {
          [diskId]: {
            root: diskSpelling,
            name: 'Proj',
            created_at: '2026-01-01T00:00:00.000Z',
            last_opened_at: '2026-01-01T00:00:00.000Z',
          },
        },
        deleted_workspace_ids: [],
      }),
      'utf-8',
    );

    const result = await touchWorkspaceRegistry(homeDir, 'c:\\users\\foo\\proj');

    expect(result.created).toBe(false);
    expect(result.workspaceId).toBe(diskId);
    const file = await readRegistryFile();
    expect(Object.keys(file.workspaces)).toEqual([diskId]);
    expect(file.workspaces[diskId]?.root).toBe(diskSpelling);
    expect(file.workspaces[diskId]?.name).toBe('Proj');
    expect(Date.parse(file.workspaces[diskId]?.last_opened_at ?? '')).toBeGreaterThan(
      Date.parse('2026-01-01T00:00:00.000Z'),
    );
  });

  it('keeps case-distinct POSIX roots as separate entries', async () => {
    const first = await touchWorkspaceRegistry(homeDir, '/tmp/AliasCheckFoo');
    const second = await touchWorkspaceRegistry(homeDir, '/tmp/aliascheckfoo');

    expect(second.created).toBe(true);
    expect(second.workspaceId).not.toBe(first.workspaceId);
  });
});
