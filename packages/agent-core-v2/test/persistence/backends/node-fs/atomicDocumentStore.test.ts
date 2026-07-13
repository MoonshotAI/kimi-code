import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicDocumentStore, IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { JsonAtomicDocumentStore, TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

interface State {
  readonly title?: string;
  readonly count?: number;
}

describe('JsonAtomicDocumentStore', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let storage: InMemoryStorageService;
  let config: IAtomicDocumentStore;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    storage = new InMemoryStorageService();
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
    config = ix.get(IAtomicDocumentStore);
  });

  afterEach(() => disposables.dispose());

  it('get returns undefined for a missing key', async () => {
    expect(await config.get('session', 'state.json')).toBeUndefined();
  });

  it('set + get round-trips a value', async () => {
    await config.set<State>('session', 'state.json', { title: 'hello', count: 1 });
    expect(await config.get<State>('session', 'state.json')).toEqual({ title: 'hello', count: 1 });
  });

  it('set atomically replaces the previous value', async () => {
    await config.set<State>('session', 'state.json', { title: 'old' });
    await config.set<State>('session', 'state.json', { title: 'new', count: 2 });
    expect(await config.get<State>('session', 'state.json')).toEqual({ title: 'new', count: 2 });
  });

  it('keys are independent', async () => {
    await config.set<State>('session', 'a.json', { title: 'A' });
    await config.set<State>('session', 'b.json', { title: 'B' });
    expect(await config.get<State>('session', 'a.json')).toEqual({ title: 'A' });
    expect(await config.get<State>('session', 'b.json')).toEqual({ title: 'B' });
  });

  it('scopes are isolated', async () => {
    await config.set<State>('scope-a', 'k', { title: 'A' });
    await config.set<State>('scope-b', 'k', { title: 'B' });
    expect(await config.get<State>('scope-a', 'k')).toEqual({ title: 'A' });
    expect(await config.get<State>('scope-b', 'k')).toEqual({ title: 'B' });
  });

  it('delete removes a key; missing delete is a no-op', async () => {
    await config.set<State>('session', 'state.json', { title: 'x' });
    await config.delete('session', 'state.json');
    expect(await config.get('session', 'state.json')).toBeUndefined();
    await expect(config.delete('session', 'state.json')).resolves.toBeUndefined();
  });

  it('list returns keys, optionally filtered by prefix', async () => {
    await config.set('session', 'job-1', {});
    await config.set('session', 'job-2', {});
    await config.set('session', 'state.json', {});
    expect((await config.list('session')).toSorted()).toEqual(['job-1', 'job-2', 'state.json']);
    expect((await config.list('session', 'job-')).toSorted()).toEqual(['job-1', 'job-2']);
  });

  it('value is persisted through the underlying IFileSystemStorageService', async () => {
    await config.set<State>('session', 'state.json', { title: 'x' });
    const raw = new TextDecoder().decode(await storage.read('session', 'state.json'));
    expect(JSON.parse(raw)).toEqual({ title: 'x' });
  });

  it('watch fires when the document is set', async () => {
    const fired = new Promise<void>((resolve) => {
      const sub = config.watch('session', 'state.json')(() => {
        sub.dispose();
        resolve();
      });
    });
    await config.set<State>('session', 'state.json', { title: 'x' });
    await expect(fired).resolves.toBeUndefined();
  });

  it('throws storage.decode_failed when the stored bytes are not valid JSON', async () => {
    await storage.append('session', 'bad.json', new TextEncoder().encode('{ not json'));
    await expect(config.get('session', 'bad.json')).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({
        code: 'storage.decode_failed',
        details: { scope: 'session', key: 'bad.json', format: 'json' },
      });
      expect((error as { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
      return true;
    });
  });
});

describe('TomlAtomicDocumentStore', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let storage: InMemoryStorageService;
  let config: IAtomicDocumentStore;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    storage = new InMemoryStorageService();
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    config = ix.get(IAtomicTomlDocumentStore);
  });

  afterEach(() => disposables.dispose());

  it('get returns undefined for a missing key', async () => {
    expect(await config.get('session', 'config.toml')).toBeUndefined();
  });

  it('set + get round-trips a value as TOML', async () => {
    await config.set<State>('session', 'config.toml', { title: 'hello', count: 1 });
    expect(await config.get<State>('session', 'config.toml')).toEqual({ title: 'hello', count: 1 });
  });

  it('set atomically replaces the previous value', async () => {
    await config.set<State>('session', 'config.toml', { title: 'old' });
    await config.set<State>('session', 'config.toml', { title: 'new', count: 2 });
    expect(await config.get<State>('session', 'config.toml')).toEqual({ title: 'new', count: 2 });
  });

  it('value is persisted as TOML through the underlying IFileSystemStorageService', async () => {
    await config.set<State>('session', 'config.toml', { title: 'x' });
    const raw = new TextDecoder().decode(await storage.read('session', 'config.toml'));
    expect(raw).toContain('title = "x"');
    expect(() => JSON.parse(raw)).toThrow();
  });

  it('watch fires when the document is set', async () => {
    const fired = new Promise<void>((resolve) => {
      const sub = config.watch('session', 'config.toml')(() => {
        sub.dispose();
        resolve();
      });
    });
    await config.set<State>('session', 'config.toml', { title: 'x' });
    await expect(fired).resolves.toBeUndefined();
  });

  it('throws storage.decode_failed when the stored bytes are not valid TOML', async () => {
    await storage.append('session', 'bad.toml', new TextEncoder().encode('key = [unclosed'));
    await expect(config.get('session', 'bad.toml')).rejects.toMatchObject({
      code: 'storage.decode_failed',
      details: { scope: 'session', key: 'bad.toml', format: 'toml' },
    });
  });
});
