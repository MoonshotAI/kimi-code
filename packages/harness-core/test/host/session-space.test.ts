import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fsSessionSpace, memorySessionSpace, SessionSpaceError } from '#/host/session-space';
import type { SessionSpace } from '#/host/session-space';

const bytes = new TextEncoder().encode('blob');

async function writeMarker(space: SessionSpace, id: string, text: string): Promise<void> {
  const container = await space.open(id);
  await container.trees.write('session', '_session', text);
  await container.blobs.write('aa', bytes);
}

async function readMarker(space: SessionSpace, id: string): Promise<string> {
  return (await space.open(id)).trees.read('session', '_session');
}

async function exerciseSpace(space: SessionSpace): Promise<void> {
  await space.create('alpha', { title: 'one', workspaceId: 'ws' });
  await writeMarker(space, 'alpha', 'hello');
  expect(await space.list()).toEqual([{ id: 'alpha', title: 'one', workspaceId: 'ws' }]);
  await expect(space.create('alpha')).rejects.toMatchObject({ reason: 'already-exists' });
  await expect(space.open('missing')).rejects.toBeInstanceOf(SessionSpaceError);
  const copied = await space.copy('alpha', 'beta');
  expect(await copied.trees.read('session', '_session')).toBe('hello');
  expect(await copied.blobs.has('aa')).toBe(true);
  await (await space.open('alpha')).trees.write('session', '_session', 'changed');
  expect(await readMarker(space, 'beta')).toBe('hello');
  expect(await space.update('beta', { title: 'two' })).toEqual({
    id: 'beta',
    title: 'two',
    workspaceId: 'ws',
  });
  await space.delete('alpha');
  expect(await space.get('alpha')).toBeUndefined();
  expect((await space.list()).map((record) => record.id)).toEqual(['beta']);
}

describe('session space', () => {
  it('creates, copies, updates, and deletes sessions in memory', async () => {
    await exerciseSpace(memorySessionSpace());
  });

  it('persists the same catalog and container bytes on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-space-'));
    try {
      await exerciseSpace(fsSessionSpace(root));
      const reopened = fsSessionSpace(root);
      expect(await reopened.get('beta')).toEqual({ id: 'beta', title: 'two', workspaceId: 'ws' });
      expect(await readMarker(reopened, 'beta')).toBe('hello');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
