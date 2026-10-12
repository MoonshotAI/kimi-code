import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { memorySessionSpace, createHarness, type AppHandle } from '@moonshot-ai/agent-core';

import { createNodeOsHost, type OsHost } from '#/features/os/host/index';
import {
  createWorkspaces,
  encodeWorkDirKey,
  getWorkspaceEntry,
  sessionWorkspaceId,
  WorkspaceFsError,
  WorkspaceRef,
  workspacesProjection,
  type WorkspaceEntry,
  type WorkspacesFace,
} from '#/features/workspaces/index';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

const apps: AppHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.disposeAsync()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface WorkspacesEnv {
  readonly app: AppHandle;
  readonly face: WorkspacesFace;
  readonly homeDir: string;
  readonly spec: ReturnType<typeof createWorkspaces>;
}

async function mountWorkspaces(
  options: { host?: OsHost; homeDir?: string; now?: () => number; defaultRoot?: string } = {},
): Promise<WorkspacesEnv> {
  const homeDir = options.homeDir ?? (await tempDir('workspaces-home-'));
  const spec = createWorkspaces({
    homeDir,
    host: options.host,
    now: options.now,
    defaultRoot: options.defaultRoot,
  });
  const app = createHarness({
    space: memorySessionSpace(),
    features: [spec],
  });
  apps.push(app);
  await app.ready();
  return { app, face: app.resolve(WorkspaceRef), homeDir, spec };
}

async function expectFsError(work: Promise<unknown>, code: string, message: string): Promise<void> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceFsError);
    expect((error as WorkspaceFsError).code).toBe(code);
    expect((error as WorkspaceFsError).message).toBe(message);
    return;
  }
  throw new Error(`expected WorkspaceFsError ${code}`);
}

describe('workspaces registry', () => {
  it('registers, dedupes by root, touches, renames, deletes and fires feature events', async () => {
    let now = 1000;
    const { app, face, spec } = await mountWorkspaces({ host: createNodeOsHost(), now: () => now });
    const root = await tempDir('ws-root-a-');
    const events: string[] = [];
    app.on(spec, 'workspace.created', () => events.push('created'));
    app.on(spec, 'workspace.updated', () => events.push('updated'));
    app.on(spec, 'workspace.deleted', () => events.push('deleted'));

    const created = await face.createOrTouch(root);
    expect(created.id).toBe(encodeWorkDirKey(root));
    expect(created.id).toMatch(/^wd_[a-z0-9._-]+_[0-9a-f]{12}$/);
    expect(created).toMatchObject({
      root,
      name: root.split('/').pop(),
      createdAt: 1000,
      lastOpenedAt: 1000,
    });

    now = 2000;
    const touched = await face.createOrTouch(root);
    expect(touched.id).toBe(created.id);
    expect(touched.lastOpenedAt).toBe(2000);
    expect(touched.createdAt).toBe(1000);
    expect(face.list()).toHaveLength(1);

    const named = await face.createOrTouch(await tempDir('ws-root-b-'), 'custom name');
    expect(named.name).toBe('custom name');
    expect(face.list()).toHaveLength(2);
    expect(face.get(created.id)).toMatchObject({ id: created.id, lastOpenedAt: 2000 });
    expect(face.findByRoot(root)?.id).toBe(created.id);
    expect(face.findByRoot(`${root}/`)?.id).toBe(created.id);

    const renamed = await face.update(created.id, { name: 'renamed' });
    expect(renamed?.name).toBe('renamed');
    expect(await face.update('wd_ghost_000000000000', { name: 'x' })).toBeUndefined();

    await face.delete(created.id);
    expect(face.get(created.id)).toBeUndefined();
    expect(face.list().map((ws) => ws.id)).toEqual([named.id]);

    now = 3000;
    const recreated = await face.createOrTouch(root);
    expect(recreated.id).toBe(created.id);
    expect(recreated.name).toBe(root.split('/').pop());
    expect(recreated.createdAt).toBe(3000);
    expect(events).toEqual(['created', 'updated', 'created', 'updated', 'deleted', 'created']);
  });

  it('validates the root with the host and skips the check without one', async () => {
    const { face } = await mountWorkspaces({ host: createNodeOsHost() });
    const missing = join(await tempDir('ws-missing-parent-'), 'nope');
    await expectFsError(
      face.createOrTouch(missing),
      'fs.path_not_found',
      `workspace root ${missing} does not exist`,
    );
    const filePath = join(await tempDir('ws-file-root-'), 'file.txt');
    await writeFile(filePath, 'x', 'utf8');
    await expectFsError(
      face.createOrTouch(filePath),
      'fs.path_not_found',
      `workspace root ${filePath} is not a directory`,
    );

    const bare = await mountWorkspaces({});
    expect(bare.face.fs).toBeUndefined();
    const created = await bare.face.createOrTouch(missing);
    expect(created.root).toBe(missing);
    expect(bare.face.list()).toHaveLength(1);
  });

  it('tracks trust per workspace, keeps it across delete, and reports unknown ids', async () => {
    const { face } = await mountWorkspaces({ host: createNodeOsHost() });
    const root = await tempDir('ws-trust-');
    const ws = await face.createOrTouch(root);

    expect(face.getTrust(ws.id)).toBe(false);
    expect(face.isTrusted(root)).toBe(false);
    expect(await face.trust(ws.id)).toBe(true);
    expect(face.getTrust(ws.id)).toBe(true);
    expect(face.isTrusted(root)).toBe(true);
    expect(await face.untrust(ws.id)).toBe(false);
    expect(face.getTrust(ws.id)).toBe(false);

    await face.trust(ws.id);
    await face.trust(ws.id);
    await face.delete(ws.id);
    expect(face.isTrusted(root)).toBe(true);

    expect(face.getTrust('wd_ghost_000000000000')).toBeUndefined();
    expect(await face.trust('wd_ghost_000000000000')).toBeUndefined();
    expect(await face.untrust('wd_ghost_000000000000')).toBeUndefined();
  });

  it('counts sessions bound to the workspace id', async () => {
    const defaultRoot = await tempDir('ws-default-');
    const { app, face } = await mountWorkspaces({ host: createNodeOsHost(), defaultRoot });
    const root = await tempDir('ws-count-');
    const ws = await face.createOrTouch(root);
    expect(await face.sessionCount(ws.id)).toBe(0);
    const first = await face.openSession(root, { sessionId: 'ses_ws_count_1' });
    await face.openSession(root, { sessionId: 'ses_ws_count_2' });
    expect(sessionWorkspaceId(await app.space.get(first.sessionId))).toBe(ws.id);
    expect(await app.space.get('ses_ws_count_2').then(sessionWorkspaceId)).toBe(ws.id);
    expect(await face.sessionCount(ws.id)).toBe(2);

    const bare = await app.open({ sessionId: 'ses_ws_count_3' });
    let bound: string | undefined;
    for (let i = 0; i < 100 && bound === undefined; i += 1) {
      bound = sessionWorkspaceId(await app.space.get(bare.sessionId));
      if (bound === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const defaultWs = face.findByRoot(defaultRoot);
    expect(defaultWs).toBeDefined();
    expect(bound).toBe(defaultWs?.id);
    expect(defaultWs === undefined ? 0 : await face.sessionCount(defaultWs.id)).toBe(1);
  });

  it('restores registry, trust and tombstones from the journal across remounts', async () => {
    const host = createNodeOsHost();
    const homeDir = await tempDir('ws-home-persist-');
    const root = await tempDir('ws-persist-');

    const first = await mountWorkspaces({ host, homeDir });
    const ws = await first.face.createOrTouch(root, 'persisted');
    await first.face.trust(ws.id);
    const gone = await first.face.createOrTouch(await tempDir('ws-persist-gone-'));
    await first.face.delete(gone.id);
    await first.app.disposeAsync();

    const second = await mountWorkspaces({ host, homeDir });
    expect(second.face.list().map((entry) => entry.id)).toEqual([ws.id]);
    expect(second.face.get(ws.id)).toMatchObject({ name: 'persisted', root });
    expect(second.face.getTrust(ws.id)).toBe(true);
    expect(second.face.get(gone.id)).toBeUndefined();
    expect(second.face.state.value.deletedIds.has(gone.id)).toBe(true);

    const journal = await readFile(join(homeDir, 'workspaces', 'journal.jsonl'), 'utf8');
    const types = journal
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(types).toEqual([
      'workspace.created',
      'workspace.trust.set',
      'workspace.created',
      'workspace.deleted',
    ]);

    const memoryOnly = await mountWorkspaces({});
    await memoryOnly.face.createOrTouch(await tempDir('ws-memory-'));
    expect(memoryOnly.face.list()).toHaveLength(1);
    await memoryOnly.app.disposeAsync();
    const journalText = await readFile(
      join(memoryOnly.homeDir, 'workspaces', 'journal.jsonl'),
      'utf8',
    ).catch(() => undefined);
    expect(journalText).toBeUndefined();
  });

  it('resolves aliases and cascades deletes at the projection level', () => {
    const entry: WorkspaceEntry = {
      id: 'wd_main_aaaaaaaaaaaa',
      root: '/tmp/main',
      name: 'main',
      createdAt: 1,
      lastOpenedAt: 1,
    };
    let state = workspacesProjection.initial();
    const reduce = (event: Parameters<typeof workspacesProjection.reduce>[1]): void => {
      state = workspacesProjection.reduce(state, event, 0);
    };
    reduce({ type: 'workspace.created', workspace: entry });
    reduce({ type: 'workspace.alias', aliasId: 'wd_alias_bbbbbbbbbbbb', workspaceId: entry.id });
    expect(getWorkspaceEntry(state, 'wd_alias_bbbbbbbbbbbb')).toEqual(entry);
    reduce({ type: 'workspace.trust.set', key: 'trust-key', trusted: true, trustedAt: 5 });
    expect(state.trust.get('trust-key')).toBe(5);
    reduce({
      type: 'workspace.deleted',
      id: entry.id,
      root: entry.root,
      aliasIds: [entry.id, 'wd_alias_bbbbbbbbbbbb'],
    });
    expect(getWorkspaceEntry(state, entry.id)).toBeUndefined();
    expect(getWorkspaceEntry(state, 'wd_alias_bbbbbbbbbbbb')).toBeUndefined();
    expect(state.deletedIds.has(entry.id)).toBe(true);
    expect(state.deletedIds.has('wd_alias_bbbbbbbbbbbb')).toBe(true);
    expect(state.trust.get('trust-key')).toBe(5);
    reduce({ type: 'workspace.created', workspace: { ...entry, createdAt: 9, lastOpenedAt: 9 } });
    expect(state.deletedIds.has(entry.id)).toBe(false);
    expect(getWorkspaceEntry(state, entry.id)?.createdAt).toBe(9);
  });
});

describe('workspaces fs browsing', () => {
  it('browses directories and serves the home payload with recent roots', async () => {
    const { face } = await mountWorkspaces({ host: createNodeOsHost() });
    const fs = face.fs;
    if (fs === undefined) throw new Error('fs unavailable');
    const root = await realpath(await tempDir('ws-browse-'));
    await mkdir(join(root, 'alpha'));
    await mkdir(join(root, '.hidden'));
    await mkdir(join(root, 'beta'));
    await writeFile(join(root, 'file.txt'), 'x', 'utf8');

    const listed = await fs.browse(root);
    expect(listed.path).toBe(root);
    expect(listed.parent).toBe(join(root, '..'));
    expect(listed.entries).toEqual([
      { name: 'alpha', path: join(root, 'alpha'), is_dir: true },
      { name: 'beta', path: join(root, 'beta'), is_dir: true },
      { name: '.hidden', path: join(root, '.hidden'), is_dir: true },
    ]);

    const top = await fs.browse('/');
    expect(top.path).toBe('/');
    expect(top.parent).toBeNull();

    await expectFsError(fs.browse('relative/path'), 'fs.not_absolute', 'path must be absolute: relative/path');
    await expectFsError(
      fs.browse(join(root, 'missing')),
      'fs.path_not_found',
      `path not found: ${join(root, 'missing')}`,
    );

    const homeBefore = await fs.home();
    expect(homeBefore.recent_roots).toEqual([]);
    const ws = await face.createOrTouch(root);
    const home = await fs.home();
    expect(home.home.length).toBeGreaterThan(0);
    expect(home.recent_roots).toEqual([ws.root]);
  });

  it('lists, reads, stats and creates directories inside a workspace view', async () => {
    const { face } = await mountWorkspaces({ host: createNodeOsHost() });
    const fs = face.fs;
    if (fs === undefined) throw new Error('fs unavailable');
    const root = await realpath(await tempDir('ws-view-'));
    await mkdir(join(root, 'docs'));
    await mkdir(join(root, '.secret'));
    await writeFile(join(root, 'docs', 'note.md'), '# hello\nworld\n', 'utf8');
    await writeFile(join(root, 'app.ts'), 'const x = 1;\n', 'utf8');
    await writeFile(join(root, '.secret', 'hidden.txt'), 'h', 'utf8');
    await writeFile(join(root, '.gitignore'), 'ignored.txt\n', 'utf8');
    await writeFile(join(root, 'ignored.txt'), 'nope', 'utf8');

    const view = fs.view({ workDir: root });
    const listed = await view.list({
      path: '.',
      depth: 1,
      limit: 200,
      show_hidden: false,
      follow_gitignore: true,
      sort: 'type_first',
      include_git_status: false,
    });
    expect(listed.truncated).toBe(false);
    expect(listed.items.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      'directory:docs',
      'file:app.ts',
    ]);
    const docsEntry = listed.items[0];
    expect(docsEntry?.name).toBe('docs');
    expect(Number.isNaN(Date.parse(docsEntry?.modified_at ?? ''))).toBe(false);
    expect(typeof docsEntry?.etag).toBe('string');

    const deep = await view.list({
      path: '.',
      depth: 2,
      limit: 200,
      show_hidden: true,
      follow_gitignore: false,
      sort: 'type_first',
      include_git_status: false,
    });
    expect(deep.children_by_path?.['docs']?.map((entry) => entry.path)).toEqual(['docs/note.md']);

    const read = await view.read({ path: 'docs/note.md', offset: 0, length: 1_048_576, encoding: 'auto' });
    expect(read).toMatchObject({
      path: 'docs/note.md',
      content: '# hello\nworld\n',
      encoding: 'utf-8',
      truncated: false,
      mime: 'text/markdown',
      language_id: 'markdown',
      line_count: 2,
      is_binary: false,
    });

    const windowed = await view.read({ path: 'app.ts', offset: 6, length: 3, encoding: 'auto' });
    expect(windowed.content).toBe('x =');
    expect(windowed.truncated).toBe(true);

    await writeFile(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]), 'utf8');
    const binary = await view.read({ path: 'bin.dat', offset: 0, length: 1_048_576, encoding: 'auto' });
    expect(binary.encoding).toBe('base64');
    expect(binary.is_binary).toBe(true);
    await expectFsError(
      view.read({ path: 'bin.dat', offset: 0, length: 1_048_576, encoding: 'utf-8' }),
      'fs.is_binary',
      'file is binary: bin.dat',
    );
    await expectFsError(
      view.read({ path: 'docs', offset: 0, length: 1_048_576, encoding: 'auto' }),
      'fs.is_directory',
      'path is a directory: docs',
    );
    await expectFsError(
      view.read({ path: '../escape.txt', offset: 0, length: 1, encoding: 'auto' }),
      'fs.path_escapes',
      'path "../escape.txt" rejected (dotdot segment)',
    );

    const stat = await view.stat({ path: 'app.ts' });
    expect(stat).toMatchObject({ path: 'app.ts', name: 'app.ts', kind: 'file', mime: 'text/typescript', language_id: 'typescript' });
    const many = await view.statMany({ paths: ['app.ts', 'missing.txt'] });
    expect(many.entries['app.ts']).toMatchObject({ kind: 'file' });
    expect(many.entries['missing.txt']).toBeNull();

    const made = await view.mkdir({ path: 'docs/nested', recursive: false });
    expect(made).toMatchObject({ path: 'docs/nested', kind: 'directory' });
    await expectFsError(
      view.mkdir({ path: 'docs/nested', recursive: false }),
      'fs.already_exists',
      'path already exists: docs/nested',
    );
    await expectFsError(
      view.mkdir({ path: 'ghost/child', recursive: false }),
      'fs.path_not_found',
      'parent not found: ghost/child',
    );

    const download = await view.resolveDownload('docs/note.md');
    expect(download).toMatchObject({ relative: 'docs/note.md', mime: 'text/markdown' });
    await expectFsError(
      view.resolveDownload('../escape.txt'),
      'fs.path_escapes',
      'path "../escape.txt" rejected (dotdot segment)',
    );
  });

  it('searches, suggests and greps inside a workspace view', async () => {
    const { face } = await mountWorkspaces({ host: createNodeOsHost() });
    const fs = face.fs;
    if (fs === undefined) throw new Error('fs unavailable');
    const root = await realpath(await tempDir('ws-search-'));
    const extra = await realpath(await tempDir('ws-search-extra-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'workspaces.ts'), 'export const marker = 1;\n', 'utf8');
    await writeFile(join(root, 'src', 'worker.ts'), 'marker marker\nother\nmarker\n', 'utf8');
    await writeFile(join(root, 'README.md'), '# ws\n', 'utf8');
    await writeFile(join(extra, 'shared.ts'), 'shared\n', 'utf8');

    const view = fs.view({ workDir: root, additionalDirs: [extra] });

    const found = await view.search({ query: 'work', limit: 50, follow_gitignore: true });
    expect(found.items.map((hit) => hit.path)).toEqual(['src/worker.ts', 'src/workspaces.ts']);
    expect(found.items[0]?.name).toBe('worker.ts');
    expect(found.items[0]?.score).toBeGreaterThan(0);
    expect(found.items[0]?.match_positions.length).toBeGreaterThan(0);

    const topLevel = await view.search({ query: '', limit: 50, follow_gitignore: true });
    expect(topLevel.items.map((hit) => hit.path)).toEqual(['src', 'README.md']);

    const suggested = await view.suggest({
      query: 'work',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(suggested.items.map((item) => item.path)).toEqual(['src/worker.ts', 'src/workspaces.ts']);
    expect(suggested.items[0]?.kind).toBe('file');

    const multiRoot = await view.suggest({
      query: 'shared',
      limit: 50,
      follow_gitignore: true,
      show_hidden: false,
    });
    expect(multiRoot.items.map((item) => item.path)).toEqual([join(extra, 'shared.ts')]);

    const grepped = await view.grep({
      pattern: 'marker',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 1,
    });
    expect(grepped.truncated).toBe(false);
    expect(grepped.files_scanned).toBe(3);
    const worker = grepped.files.find((file) => file.path === 'src/worker.ts');
    expect(worker?.matches).toHaveLength(2);
    expect(worker?.matches[0]).toMatchObject({ line: 1, col: 1, text: 'marker marker', before: [], after: ['other'] });
    expect(worker?.matches[1]).toMatchObject({ line: 3, col: 1, before: ['other'], after: [''] });
  });

  it('reports git status and diffs inside a workspace view', async () => {
    const { face } = await mountWorkspaces({ host: createNodeOsHost() });
    const fs = face.fs;
    if (fs === undefined) throw new Error('fs unavailable');
    const root = await realpath(await tempDir('ws-git-'));
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.email', 'ws-test@example.com');
    await git(root, 'config', 'user.name', 'WS Test');
    await git(root, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(root, 'tracked.txt'), 'one\ntwo\n', 'utf8');
    await git(root, 'add', 'tracked.txt');
    await git(root, 'commit', '-m', 'init');
    await writeFile(join(root, 'tracked.txt'), 'one\ntwo\nthree\n', 'utf8');
    await writeFile(join(root, 'untracked.txt'), 'new\n', 'utf8');

    const view = fs.view({ workDir: root });
    const status = await view.gitStatus({});
    expect(status).toMatchObject({
      branch: 'main',
      ahead: 0,
      behind: 0,
      entries: { 'tracked.txt': 'modified', 'untracked.txt': 'untracked' },
      additions: 1,
      deletions: 0,
      pullRequest: null,
    });

    const filtered = await view.gitStatus({ paths: ['tracked.txt'] });
    expect(filtered.entries).toEqual({ 'tracked.txt': 'modified' });

    const diff = await view.diff({ path: 'tracked.txt' });
    expect(diff).toMatchObject({ path: 'tracked.txt', truncated: false });
    expect(diff.diff).toContain('+three');

    const untracked = await view.diff({ path: 'untracked.txt' });
    expect(untracked.truncated).toBe(false);
    expect(untracked.diff).toContain('new file mode');

    await expectFsError(view.diff({ path: 'ghost.txt' }), 'fs.path_not_found', 'path not found: ghost.txt');
    await expectFsError(
      view.diff({ path: '../escape.txt' }),
      'fs.path_escapes',
      'path "../escape.txt" rejected (dotdot segment)',
    );

    const plain = await realpath(await tempDir('ws-git-plain-'));
    const plainView = fs.view({ workDir: plain });
    const unavailable = await plainView.gitStatus({}).catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(WorkspaceFsError);
    expect((unavailable as WorkspaceFsError).code).toBe('fs.git_unavailable');
    expect((unavailable as WorkspaceFsError).message).toContain(`git unavailable at ${plain}:`);
    const unavailableDiff = await plainView.diff({ path: 'x.txt' }).catch((error: unknown) => error);
    expect((unavailableDiff as WorkspaceFsError).code).toBe('fs.git_unavailable');
  });
});

describe('workspaces additional dirs', () => {
  it('persists add-dir into local.toml and resolves roots, dedupe and home expansion', async () => {
    const { face } = await mountWorkspaces({ host: createNodeOsHost() });
    const root = await realpath(await tempDir('ws-add-dir-'));
    await mkdir(join(root, '.git'));
    await writeFile(join(root, 'plain.txt'), 'x', 'utf8');
    const extra = await realpath(await tempDir('ws-add-dir-extra-'));
    const ws = await face.createOrTouch(root);

    const added = await face.addDir(ws.id, extra);
    expect(added).toMatchObject({
      projectRoot: root,
      configPath: join(root, '.kimi-code', 'local.toml'),
      additionalDirs: [extra],
      persisted: true,
    });
    const toml = await readFile(join(root, '.kimi-code', 'local.toml'), 'utf8');
    expect(toml).toContain('additional_dir');
    expect(toml).toContain(extra);

    const again = await face.addDir(ws.id, extra);
    expect(again?.additionalDirs).toEqual([extra]);

    const nested = join(root, 'sub');
    await mkdir(nested);
    const fromNested = await face.addDir(ws.id, 'sub');
    expect(fromNested?.additionalDirs).toEqual([extra, nested]);

    const second = await realpath(await tempDir('ws-add-dir-second-'));
    const ephemeral = await face.addDir(ws.id, second, false);
    expect(ephemeral).toMatchObject({ additionalDirs: [extra, nested, second], persisted: false });
    expect(await face.additionalDirs(ws.id)).toEqual([extra, nested, second]);

    await expectFsError(
      face.addDir(ws.id, join(root, 'missing')),
      'fs.path_not_found',
      `path ${join(root, 'missing')} does not exist`,
    );
    await expectFsError(
      face.addDir(ws.id, join(root, 'plain.txt')),
      'fs.path_not_found',
      `path ${join(root, 'plain.txt')} is not a directory`,
    );
    expect(await face.addDir('wd_ghost_000000000000', extra)).toBeUndefined();
  });
});
