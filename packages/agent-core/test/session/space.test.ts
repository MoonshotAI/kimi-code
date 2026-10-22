import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { nodeSessionSpace } from '#/session/backend/node';
import {
  memorySessionSpace,
  SessionSpaceError,
  type SessionContainer,
  type SessionSpace,
} from '#/session/index';
import { openWriter, type Log, type Writer } from '#/store/index';

const bytes = new TextEncoder().encode('blob');

type MarkerEvent = { readonly type: 'marker'; readonly value: string };

async function markerLog(
  container: SessionContainer,
): Promise<{ writer: Writer; log: Log<MarkerEvent> }> {
  const writer = openWriter(container.journal);
  const log = await writer.open<MarkerEvent>('markers');
  return { writer, log };
}

function markerValues(log: Log<MarkerEvent>): string[] {
  return log.replica.entries().map((entry) => entry.event.value);
}

afterEach(() => {
  vi.useRealTimers();
});

async function exerciseSpace(space: SessionSpace): Promise<{ blobRef: string }> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  const alpha = await space.create('alpha', { title: 'one', metadata: { workspaceId: 'ws' } });
  const alphaWriter = openWriter(alpha.journal);
  const alphaLog = await alphaWriter.open<MarkerEvent>('markers');
  await alphaLog.commit({ events: [{ type: 'marker', value: 'hello' }] });
  const { ref: blobRef } = await alpha.blobs().put({ bytes });
  expect(alpha.blobs()).toBe(alpha.blobs());
  const fileHistory = alpha.blobs('file-history');
  const { ref: prefixedRef } = await fileHistory.put({ bytes });
  expect(prefixedRef).toBe(blobRef);
  expect(await fileHistory.list()).toEqual([prefixedRef]);
  expect(await alpha.blobs().list()).toEqual([blobRef]);
  await fileHistory.delete(prefixedRef);
  expect(await fileHistory.has(prefixedRef)).toBe(false);
  expect(await fileHistory.list()).toEqual([]);
  expect(await alpha.blobs().has(blobRef)).toBe(true);
  expect(() => alpha.blobs('../x')).toThrow(TypeError);
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
  const copiedWriter = openWriter(copied.journal);
  const copiedLog = await copiedWriter.open<MarkerEvent>('markers');
  expect(markerValues(copiedLog)).toEqual(['hello']);
  expect(await copied.blobs().has(blobRef)).toBe(true);
  await copiedWriter.close();

  await alphaLog.commit({ events: [{ type: 'marker', value: 'changed' }] });
  const beta = await space.open('beta');
  const betaWriter = openWriter(beta.journal);
  const betaLog = await betaWriter.open<MarkerEvent>('markers');
  expect(markerValues(betaLog)).toEqual(['hello']);
  await betaWriter.close();

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

  await alphaWriter.close();
  await space.delete('alpha');
  expect(await space.get('alpha')).toBeUndefined();
  expect((await space.list()).map((record) => record.id)).toEqual(['beta']);
  return { blobRef };
}

describe('session space', () => {
  it('creates, copies, updates, and deletes sessions in memory', async () => {
    const { blobRef } = await exerciseSpace(memorySessionSpace());
    expect(blobRef).toMatch(/^[0-9a-f]{64}$/);
  });

  it('persists the same catalog and container bytes on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-space-'));
    try {
      const { blobRef } = await exerciseSpace(nodeSessionSpace(root));
      const reopened = nodeSessionSpace(root);
      expect(await reopened.get('beta')).toEqual({
        id: 'beta',
        title: 'two',
        metadata: { workspaceId: 'ws', extra: 1 },
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-04T00:00:00.000Z',
      });
      const beta = await reopened.open('beta');
      const { writer, log } = await markerLog(beta);
      expect(markerValues(log)).toEqual(['hello']);
      await writer.close();
      expect((await beta.blobs().get(blobRef))?.bytes).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads legacy records without timestamps and stamps updatedAt on update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-space-'));
    try {
      await mkdir(join(root, 'ses_legacy'), { recursive: true });
      await writeFile(
        join(root, 'ses_legacy', 'record.json'),
        JSON.stringify({ title: 'legacy', metadata: { workspaceId: 'ws' } }),
      );
      const space = nodeSessionSpace(root);
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
