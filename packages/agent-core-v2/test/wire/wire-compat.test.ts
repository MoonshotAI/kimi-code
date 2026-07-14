import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { resetUnexpectedErrorHandler, setUnexpectedErrorHandler } from '#/_base/errors/unexpectedError';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { defineModel } from '#/wire/model';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from './stubs';

const SCOPE = 'wire';
const KEY = 'round-trip';

const CounterModel = defineModel('compat.counter', () => ({ value: 0 }));
const TagsModel = defineModel('compat.tags', () => ({ tags: [] as string[] }));

const counterSet = CounterModel.defineOp('compat.counter.set', {
  schema: z.object({ value: z.number() }),
  apply: (_s, p) => ({ value: p.value }),
});
const tagsAdd = TagsModel.defineOp('compat.tags.add', {
  schema: z.object({ tag: z.string() }),
  apply: (s, p) => ({ tags: [...s.tags, p.tag] }),
});

const cleanups: string[] = [];
const disposables: DisposableStore[] = [];

afterEach(async () => {
  for (const store of disposables.splice(0)) store.dispose();
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeDir(): Promise<string> {
  const dir = join(tmpdir(), `wire-compat-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  cleanups.push(dir);
  return dir;
}

function makeContainer(storage: IFileSystemStorageService, logKey: string) {
  const store = new DisposableStore();
  disposables.push(store);
  const ix = store.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, storage);
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  const log = ix.get(IAppendLogStore);
  const wire = registerTestAgentWire(ix, testWireScope(SCOPE, logKey), { log });
  return { ix, wire, log };
}

function makeReader(storage: IFileSystemStorageService): IAppendLogStore {
  const store = new DisposableStore();
  disposables.push(store);
  const ix = store.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, storage);
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  return ix.get(IAppendLogStore);
}

async function collect(log: IAppendLogStore): Promise<WireRecord[]> {
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

describe('wire.jsonl round-trip', () => {
  it('persists { type, ...payload } and rebuilds equal state via replay on a fresh service', async () => {
    const dir = await makeDir();
    const storage = new FileStorageService(dir);
    const live = makeContainer(storage, KEY);

    live.wire.dispatch(counterSet({ value: 3 }));
    live.wire.dispatch(tagsAdd({ tag: 'a' }), tagsAdd({ tag: 'b' }));
    await live.log.flush();

    const records = await collect(makeReader(storage));

    expect(records).toEqual([
      { type: 'compat.counter.set', value: 3, time: expect.any(Number) },
      { type: 'compat.tags.add', tag: 'a', time: expect.any(Number) },
      { type: 'compat.tags.add', tag: 'b', time: expect.any(Number) },
    ]);
    for (const record of records) {
      expect('payload' in record).toBe(false);
    }

    const replayTarget = makeContainer(storage, 'replay-target');
    const withUnknown: WireRecord[] = [
      ...records,
      { type: 'compat.unknown.nope', foo: 1 },
    ];
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      await restoreTestAgentWire(
        replayTarget.wire,
        replayTarget.log,
        testWireScope(SCOPE, 'replay-target'),
        withUnknown,
      );
    } finally {
      resetUnexpectedErrorHandler();
    }

    expect(unexpected).toHaveLength(1);
    expect(replayTarget.wire.getModel(CounterModel)).toEqual(
      live.wire.getModel(CounterModel),
    );
    expect(replayTarget.wire.getModel(TagsModel)).toEqual(live.wire.getModel(TagsModel));
  });
});
