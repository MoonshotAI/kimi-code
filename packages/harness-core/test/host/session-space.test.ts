import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { memorySessionSpace, SessionSpaceError, type SessionSpace } from '@moonshot-ai/agent-core';

import { fsSessionSpace } from '#/host/session-space';

const bytes = new TextEncoder().encode('blob');

afterEach(() => {
  vi.useRealTimers();
});

async function writeMarker(space: SessionSpace, id: string, text: string): Promise<void> {
  const container = await space.open(id);
  await container.trees.write('session', '_session', text);
  await container.blobs.write('aa', bytes);
}

async function readMarker(space: SessionSpace, id: string): Promise<string> {
  return (await space.open(id)).trees.read('session', '_session');
}

async function exerciseSpace(space: SessionSpace): Promise<void> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  await space.create('alpha', { title: 'one', metadata: { workspaceId: 'ws' } });
  await writeMarker(space, 'alpha', 'hello');
  expect(await space.list()).toEqual([
    {
      id: 'alpha',
      title: 'one',
      metadata: { workspaceId: 'ws' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
  await expect(space.create('alpha')).rejects.toMatchObject({ reason: 'already-exists' });
  await expect(space.open('missing')).rejects.toBeInstanceOf(SessionSpaceError);
  vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
  const copied = await space.copy('alpha', 'beta');
  expect(await copied.trees.read('session', '_session')).toBe('hello');
  expect(await copied.blobs.has('aa')).toBe(true);
  await (await space.open('alpha')).trees.write('session', '_session', 'changed');
  expect(await readMarker(space, 'beta')).toBe('hello');
  vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'));
  expect(await space.update('beta', { title: 'two' })).toEqual({
    id: 'beta',
    title: 'two',
    metadata: { workspaceId: 'ws' },
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
  });
  vi.setSystemTime(new Date('2026-01-04T00:00:00.000Z'));
  expect(await space.update('beta', { metadata: { extra: 1 } })).toEqual({
    id: 'beta',
    title: 'two',
    metadata: { workspaceId: 'ws', extra: 1 },
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-04T00:00:00.000Z',
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
      expect(await reopened.get('beta')).toEqual({
        id: 'beta',
        title: 'two',
        metadata: { workspaceId: 'ws', extra: 1 },
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-04T00:00:00.000Z',
      });
      expect(await readMarker(reopened, 'beta')).toBe('hello');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads legacy records without timestamps and stamps updatedAt on update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-space-'));
    try {
      await mkdir(join(root, 'ses_legacy'), { recursive: true });
      await writeFile(
        join(root, 'ses_legacy', 'meta.json'),
        JSON.stringify({ title: 'legacy', metadata: { workspaceId: 'ws' } }),
      );
      const space = fsSessionSpace(root);
      expect(await space.get('ses_legacy')).toEqual({
        id: 'ses_legacy',
        title: 'legacy',
        metadata: { workspaceId: 'ws' },
      });
      const updated = await space.update('ses_legacy', { title: 'renamed' });
      expect(updated.title).toBe('renamed');
      expect(updated.createdAt).toBeUndefined();
      expect(typeof updated.updatedAt).toBe('string');
      expect(Number.isNaN(Date.parse(updated.updatedAt as string))).toBe(false);
      expect(await space.get('ses_legacy')).toEqual(updated);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
