/**
 * Tests for the generic per-id JSON record store.
 *
 * Background/cron tests cover end-to-end behavior with their own task
 * shapes; these tests stay shape-agnostic so they exercise the store's
 * own invariants (path-traversal, atomic write, corrupt-skipping).
 */

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPerIdJsonStore } from '../../src/utils/per-id-json-store';

interface Sample {
  readonly id: string;
  readonly payload: string;
}

const ID_REGEX = /^[a-z0-9]{4}$/;

function isSample(obj: unknown): obj is Sample {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' &&
    ID_REGEX.test(o['id']) &&
    typeof o['payload'] === 'string'
  );
}

let rootDir: string;

beforeEach(async () => {
  rootDir = join(
    tmpdir(),
    `kimi-per-id-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(rootDir, { recursive: true });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function newStore() {
  return createPerIdJsonStore<Sample>({
    rootDir,
    subdir: 'things',
    idRegex: ID_REGEX,
    isValid: isSample,
  });
}

describe('createPerIdJsonStore', () => {
  it('round-trips a value via write/read', async () => {
    const store = newStore();
    await store.write('aaaa', { id: 'aaaa', payload: 'hello' });
    expect(await store.read('aaaa')).toEqual({ id: 'aaaa', payload: 'hello' });
  });

  it('read returns undefined for missing files', async () => {
    expect(await newStore().read('bbbb')).toBeUndefined();
  });

  it('write overwrites previous content', async () => {
    const store = newStore();
    await store.write('aaaa', { id: 'aaaa', payload: 'first' });
    await store.write('aaaa', { id: 'aaaa', payload: 'second' });
    expect((await store.read('aaaa'))?.payload).toBe('second');
  });

  it('list enumerates every record by basename', async () => {
    const store = newStore();
    await store.write('aaaa', { id: 'aaaa', payload: 'a' });
    await store.write('bbbb', { id: 'bbbb', payload: 'b' });
    const all = await store.list();
    expect(all.map((v) => v.id).toSorted()).toEqual(['aaaa', 'bbbb']);
  });

  it('list returns empty when subdir does not exist', async () => {
    expect(await newStore().list()).toEqual([]);
  });

  it('list silently skips files with invalid basenames', async () => {
    const store = newStore();
    await store.write('aaaa', { id: 'aaaa', payload: 'good' });
    // Stray file whose name fails ID_REGEX
    await writeFile(
      join(rootDir, 'things', 'NOT-A-VALID-ID.json'),
      JSON.stringify({ id: 'aaaa', payload: 'whatever' }),
      'utf-8',
    );
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe('aaaa');
  });

  it('list silently skips corrupt JSON', async () => {
    const store = newStore();
    await store.write('aaaa', { id: 'aaaa', payload: 'good' });
    await writeFile(join(rootDir, 'things', 'bbbb.json'), '{not json', 'utf-8');
    const all = await store.list();
    expect(all.map((v) => v.id)).toEqual(['aaaa']);
  });

  it('list silently skips records that fail isValid', async () => {
    const store = newStore();
    await store.write('aaaa', { id: 'aaaa', payload: 'good' });
    // Valid JSON, valid basename, but missing `payload`.
    await writeFile(
      join(rootDir, 'things', 'cccc.json'),
      JSON.stringify({ id: 'cccc' }),
      'utf-8',
    );
    const all = await store.list();
    expect(all.map((v) => v.id)).toEqual(['aaaa']);
  });

  it('read returns undefined for files that fail isValid', async () => {
    const store = newStore();
    await mkdir(join(rootDir, 'things'), { recursive: true });
    await writeFile(
      join(rootDir, 'things', 'cccc.json'),
      JSON.stringify({ id: 'cccc' }),
      'utf-8',
    );
    expect(await store.read('cccc')).toBeUndefined();
  });

  it('remove deletes the file and is idempotent', async () => {
    const store = newStore();
    await store.write('aaaa', { id: 'aaaa', payload: 'x' });
    await store.remove('aaaa');
    expect(await store.read('aaaa')).toBeUndefined();
    await expect(store.remove('aaaa')).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('write creates the subdir with mode 0700', async () => {
    const store = newStore();
    await store.write('aaaa', { id: 'aaaa', payload: 'x' });
    const st = await stat(join(rootDir, 'things'));
    // eslint-disable-next-line no-bitwise
    expect(st.mode & 0o777).toBe(0o700);
  });

  it('rejects path-traversal ids on write/read/remove', async () => {
    const store = newStore();
    await expect(
      store.write('../etc', { id: '../etc', payload: 'x' }),
    ).rejects.toThrow(/Invalid id/);
    await expect(store.read('../etc')).rejects.toThrow(/Invalid id/);
    await expect(store.remove('../etc')).rejects.toThrow(/Invalid id/);
  });

  it('uses entityName in path-traversal rejection errors', async () => {
    const store = createPerIdJsonStore<Sample>({
      rootDir,
      subdir: 'things',
      idRegex: ID_REGEX,
      isValid: isSample,
      entityName: 'thing id',
    });
    await expect(
      store.write('../etc', { id: '../etc', payload: 'x' }),
    ).rejects.toThrow(/Invalid thing id: "\.\.\/etc"/);
  });

  it('read on an unknown id does not create the subdir', async () => {
    expect(await newStore().read('dead')).toBeUndefined();
    const top = await readdir(rootDir);
    expect(top.includes('things')).toBe(false);
  });
});
