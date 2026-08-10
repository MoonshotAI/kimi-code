import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  WorkspaceCheckpointError,
  WorkspaceCheckpointStore,
} from '../../src/tui/workspace-checkpoints';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; session: string; store: WorkspaceCheckpointStore }> {
  const parent = await mkdtemp(join(tmpdir(), 'kimi-rewind-'));
  temporaryDirectories.push(parent);
  const root = join(parent, 'workspace');
  const session = join(parent, 'session');
  await mkdir(root);
  const canonicalRoot = await realpath(root);
  return { root: canonicalRoot, session, store: new WorkspaceCheckpointStore(session, [canonicalRoot]) };
}

describe('WorkspaceCheckpointStore', () => {
  it('restores modified, created, and deleted files without Git', async () => {
    const { root, store } = await fixture();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'modified.ts'), 'before\n');
    await writeFile(join(root, 'deleted.txt'), 'bring me back\n');

    await store.captureBeforeTurn();
    await writeFile(join(root, 'src', 'modified.ts'), 'after\n');
    await writeFile(join(root, 'created.txt'), 'remove me\n');
    await rm(join(root, 'deleted.txt'));

    const plan = await store.prepareRewind(1);
    expect(plan.changes).toEqual([
      { root, path: 'created.txt', kind: 'created' },
      { root, path: 'deleted.txt', kind: 'deleted' },
      { root, path: 'src/modified.ts', kind: 'modified' },
    ]);

    await store.apply(plan);
    expect(await readFile(join(root, 'src', 'modified.ts'), 'utf8')).toBe('before\n');
    expect(await readFile(join(root, 'deleted.txt'), 'utf8')).toBe('bring me back\n');
    await expect(readFile(join(root, 'created.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await store.commit(plan);
    expect(await store.availableCount()).toBe(0);
  });

  it('rewinds multiple turns to the oldest selected before-image', async () => {
    const { root, store } = await fixture();
    const file = join(root, 'counter.txt');
    await writeFile(file, 'zero');
    await store.captureBeforeTurn();
    await writeFile(file, 'one');
    await store.captureBeforeTurn();
    await writeFile(file, 'two');

    const plan = await store.prepareRewind(2);
    await store.apply(plan);
    expect(await readFile(file, 'utf8')).toBe('zero');
  });

  it('fails closed if a file changes after preview and leaves every file untouched', async () => {
    const { root, store } = await fixture();
    const first = join(root, 'first.txt');
    const second = join(root, 'second.txt');
    await writeFile(first, 'before first');
    await writeFile(second, 'before second');
    await store.captureBeforeTurn();
    await writeFile(first, 'agent first');
    await writeFile(second, 'agent second');
    const plan = await store.prepareRewind(1);

    await writeFile(second, 'external edit');
    await expect(store.apply(plan)).rejects.toThrow(/changed after the rewind preview/);
    expect(await readFile(first, 'utf8')).toBe('agent first');
    expect(await readFile(second, 'utf8')).toBe('external edit');
  });

  it('can roll the workspace forward when conversation undo fails', async () => {
    const { root, store } = await fixture();
    const file = join(root, 'file.txt');
    await writeFile(file, 'before');
    await store.captureBeforeTurn();
    await writeFile(file, 'after');
    const plan = await store.prepareRewind(1);

    await store.apply(plan);
    await store.rollback(plan);
    expect(await readFile(file, 'utf8')).toBe('after');
    expect(await store.availableCount()).toBe(1);
  });

  it('respects ignore files and never traverses symlinks or dependency trees', async () => {
    const { root, session, store } = await fixture();
    const outside = join(session, 'outside.txt');
    await mkdir(session, { recursive: true });
    await writeFile(outside, 'outside before');
    await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(root, 'ignored.txt'), 'ignored before');
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'dependency.js'), 'dependency before');
    await symlink(outside, join(root, 'linked.txt'));
    await store.captureBeforeTurn();

    await writeFile(join(root, 'ignored.txt'), 'ignored after');
    await writeFile(join(root, 'node_modules', 'dependency.js'), 'dependency after');
    await writeFile(outside, 'outside after');
    const plan = await store.prepareRewind(1);
    expect(plan.changes).toEqual([]);
  });

  it('tracks executable-mode changes', async () => {
    const { root, store } = await fixture();
    const script = join(root, 'script.sh');
    await writeFile(script, '#!/bin/sh\n');
    await chmod(script, 0o644);
    await store.captureBeforeTurn();
    await chmod(script, 0o755);

    const plan = await store.prepareRewind(1);
    expect(plan.changes).toEqual([{ root, path: 'script.sh', kind: 'modified' }]);
    await store.apply(plan);
    const restored = await import('node:fs/promises').then(({ stat }) => stat(script));
    expect(restored.mode & 0o777).toBe(0o644);
  });

  it('rejects oversized workspaces instead of creating a partial checkpoint', async () => {
    const { root, session } = await fixture();
    await writeFile(join(root, 'large.txt'), '12345');
    const store = new WorkspaceCheckpointStore(session, [root], { maxBytes: 4 });
    await expect(store.captureBeforeTurn()).rejects.toBeInstanceOf(WorkspaceCheckpointError);
    expect(await store.availableCount()).toBe(0);
  });

  it('excludes its own content store when a session directory is inside the workspace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kimi-rewind-nested-'));
    temporaryDirectories.push(parent);
    const root = join(parent, 'workspace');
    const session = join(root, '.kimi', 'sessions', 'current');
    await mkdir(root);
    await writeFile(join(root, 'source.txt'), 'unchanged');
    const store = new WorkspaceCheckpointStore(session, [root]);

    await store.captureBeforeTurn();
    const plan = await store.prepareRewind(1);
    expect(plan.changes).toEqual([]);
  });

  it('refuses to restore through a parent directory replaced by a symlink', async () => {
    const { root, session, store } = await fixture();
    const outside = join(session, 'outside');
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'file.txt'), 'before');
    await store.captureBeforeTurn();
    await rm(join(root, 'src'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(root, 'src'));

    const plan = await store.prepareRewind(1);
    await expect(store.apply(plan)).rejects.toThrow(/symlink/);
    await expect(readFile(join(outside, 'file.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bounds retained history and keeps the newest checkpoints aligned', async () => {
    const { root, session } = await fixture();
    const store = new WorkspaceCheckpointStore(session, [root], { maxCheckpoints: 2 });
    const file = join(root, 'state.txt');
    await writeFile(file, 'zero');
    await store.captureBeforeTurn();
    await writeFile(file, 'one');
    await store.captureBeforeTurn();
    await writeFile(file, 'two');
    await store.captureBeforeTurn();
    await writeFile(file, 'three');

    expect(await store.availableCount()).toBe(2);
    const plan = await store.prepareRewind(2);
    await store.apply(plan);
    expect(await readFile(file, 'utf8')).toBe('one');
  });

  it('rolls back a partially applied restore when a later checkpoint blob is corrupt', async () => {
    const { root, session, store } = await fixture();
    const first = join(root, 'a.txt');
    const second = join(root, 'b.txt');
    await writeFile(first, 'before a');
    await writeFile(second, 'before b');
    await store.captureBeforeTurn();
    await writeFile(first, 'after a');
    await writeFile(second, 'after b');
    const plan = await store.prepareRewind(1);
    const secondBeforeHash = createHash('sha256').update('before b').digest('hex');
    await writeFile(
      join(session, 'workspace-checkpoints', 'blobs', secondBeforeHash),
      'corrupt',
    );

    await expect(store.apply(plan)).rejects.toThrow(/corrupt/);
    expect(await readFile(first, 'utf8')).toBe('after a');
    expect(await readFile(second, 'utf8')).toBe('after b');
  });
});
