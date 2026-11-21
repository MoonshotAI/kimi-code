import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { memorySessionSpace } from '#/session/backend/memory';
import { nodeSessionSpace } from '#/session/backend/node';
import {
  SessionSpaceError,
  type SessionRecord,
  type SessionSpace,
} from '#/session/index';

function record(id: string): SessionRecord {
  return {
    id,
    title: `title:${id}`,
    createdAt: 100,
    updatedAt: 100,
    archived: false,
    agents: {},
    custom: { origin: 'test' },
  };
}

function sessionSpaceSuite(
  setup: () => Promise<{ space: SessionSpace; cleanup: () => Promise<void> }>,
): void {
  describe('shared behavior', () => {
    it('supports CRUD and prefix or full key listing', async () => {
      const { space, cleanup } = await setup();
      try {
        await space.create('flat', record('flat'));
        await space.create('ws-a/one', record('one'));
        await space.create('ws-ab/two', record('two'));

        expect(await space.list()).toEqual(['flat', 'ws-a/one', 'ws-ab/two']);
        expect(await space.list('ws-a/')).toEqual(['ws-a/one']);
        expect(await space.list('ws')).toEqual(['ws-a/one', 'ws-ab/two']);
        expect((await space.get('ws-a/one'))?.title).toBe('title:one');

        const updated = await space.update('ws-a/one', { title: 'renamed' });
        expect(updated).toMatchObject({ id: 'one', title: 'renamed', createdAt: 100 });
        expect(updated.updatedAt).toBeGreaterThan(100);

        const quiet = await space.update('ws-a/one', { title: 'quiet' }, { touchUpdatedAt: false });
        expect(quiet.updatedAt).toBe(updated.updatedAt);

        await space.delete('flat');
        expect(await space.get('flat')).toBeUndefined();
        expect(await space.list()).toEqual(['ws-a/one', 'ws-ab/two']);
      } finally {
        await cleanup();
      }
    });

    it('reports duplicate, missing and invalid keys', async () => {
      const { space, cleanup } = await setup();
      try {
        await space.create('ws-a/one', record('one'));
        await expect(space.create('ws-a/one', record('one'))).rejects.toMatchObject({
          reason: 'already-exists',
        });
        await expect(space.update('missing', { title: 'x' })).rejects.toMatchObject({
          reason: 'not-found',
        });
        await expect(space.delete('missing')).rejects.toMatchObject({ reason: 'not-found' });
        await expect(space.get('../outside')).rejects.toBeInstanceOf(SessionSpaceError);
        await expect(space.get('/absolute')).rejects.toMatchObject({ reason: 'invalid-key' });
        await expect(space.list('../')).rejects.toMatchObject({ reason: 'invalid-key' });
      } finally {
        await cleanup();
      }
    });

    it('preserves explicit timestamps and immutable identity fields', async () => {
      const { space, cleanup } = await setup();
      try {
        await space.create('one', { ...record('one'), createdAt: 10, updatedAt: 20 });
        const updated = await space.update('one', {
          updatedAt: 40,
          title: 'explicit',
        });
        expect(updated).toMatchObject({ id: 'one', createdAt: 10, updatedAt: 40 });
      } finally {
        await cleanup();
      }
    });
  });
}

describe('memorySessionSpace', () => {
  sessionSpaceSuite(async () => ({
    space: memorySessionSpace(),
    cleanup: async () => {},
  }));
});

describe('nodeSessionSpace', () => {
  sessionSpaceSuite(async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-space-'));
    return {
      space: nodeSessionSpace(root),
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  });
});

describe('nodeSessionSpace filesystem behavior', () => {
  it('lists corrupt records without reading them and rejects on get', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-space-'));
    try {
      await mkdir(join(root, 'ws-a', 'broken'), { recursive: true });
      await writeFile(join(root, 'ws-a', 'broken', 'state.json'), '{broken');
      const space = nodeSessionSpace(root);
      expect(await space.list()).toEqual(['ws-a/broken']);
      await expect(space.get('ws-a/broken')).rejects.toThrow(SyntaxError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads legacy metadata and deduplicates canonical and legacy keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-space-'));
    try {
      await mkdir(join(root, 'ws-a', 'one', 'session-meta'), { recursive: true });
      await writeFile(
        join(root, 'ws-a', 'one', 'session-meta', 'state.json'),
        JSON.stringify(record('one')),
      );
      const space = nodeSessionSpace(root);
      expect((await space.get('ws-a/one'))?.id).toBe('one');
      expect(await space.list()).toEqual(['ws-a/one']);
      await writeFile(
        join(root, 'ws-a', 'one', 'state.json'),
        JSON.stringify(record('one')),
      );
      expect(await space.list()).toEqual(['ws-a/one']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deletes the whole session container', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-space-'));
    try {
      const space = nodeSessionSpace(root);
      await space.create('ws-a/one', record('one'));
      await mkdir(join(root, 'ws-a', 'one', 'agents', 'main'), { recursive: true });
      await writeFile(join(root, 'ws-a', 'one', 'agents', 'main', 'wire.jsonl'), '{}\n');
      await space.delete('ws-a/one');
      await expect(stat(join(root, 'ws-a', 'one'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
