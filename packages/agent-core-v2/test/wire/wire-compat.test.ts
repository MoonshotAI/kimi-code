/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { resetUnexpectedErrorHandler, setUnexpectedErrorHandler } from '#/_base/errors/unexpectedError';
import { Event2 } from '#/app/event/event2';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { defineState } from '#/state/state';
import { todoKey } from '#/session/todo/todoOps';
import { WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
  testWireScope,
} from './stubs';

const SCOPE = 'wire';
const KEY = 'round-trip';

class CompatCounterSet extends Event2<{ value: number }> {
  static override readonly type = 'compat.counter.set';
  static override readonly durable = true;
  static override readonly schema = z.object({ value: z.number() });
}
interface CompatCounterSet extends z.infer<typeof CompatCounterSet.schema> {}

class CompatTagsAdd extends Event2<{ tag: string }> {
  static override readonly type = 'compat.tags.add';
  static override readonly durable = true;
  static override readonly schema = z.object({ tag: z.string() });
}
interface CompatTagsAdd extends z.infer<typeof CompatTagsAdd.schema> {}

const compatCounterKey = defineState('compat.counter', () => ({ value: 0 }))
  .replayable({ schema: z.object({ value: z.number() }) })
  .on(CompatCounterSet, (s, e) => {
    s.value = e.value;
  });

const compatTagsKey = defineState('compat.tags', (): { tags: string[] } => ({ tags: [] }))
  .replayable({ schema: z.object({ tags: z.array(z.string()) }) })
  .on(CompatTagsAdd, (s, e) => {
    s.tags.push(e.tag);
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
  registerTestAgentWire(ix, testWireScope(SCOPE, logKey), { log });
  const dispatcher = registerTestEventDispatcher(ix);
  const agentState = ix.get(IAgentStateService);
  agentState.contributeState(compatCounterKey);
  agentState.contributeState(compatTagsKey);
  agentState.contributeState(todoKey);
  return { ix, dispatcher, agentState, log };
}

function makeReader(storage: IFileSystemStorageService): IAppendLogStore {
  const store = new DisposableStore();
  disposables.push(store);
  const ix = store.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, storage);
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  return ix.get(IAppendLogStore);
}

async function collect(log: IAppendLogStore, key: string): Promise<WireRecord[]> {
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(testWireScope(SCOPE, key), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

async function readRawLines(dir: string, key: string): Promise<unknown[]> {
  const raw = await readFile(join(dir, testWireScope(SCOPE, key), AGENT_WIRE_RECORD_KEY), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe('wire.jsonl round-trip', () => {
  it('persists durable events as flat { type, ...payload, time } records and rebuilds equal state on restore', async () => {
    const dir = await makeDir();
    const storage = new FileStorageService(dir);
    const live = makeContainer(storage, KEY);

    await live.dispatcher.dispatch(new CompatCounterSet({ value: 3 }, 1700000000003));
    await live.dispatcher.dispatch(new CompatTagsAdd({ tag: 'a' }, 1700000000004));
    await live.dispatcher.dispatch(new CompatTagsAdd({ tag: 'b' }, 1700000000005));
    await live.dispatcher.flush();

    const records = await collect(makeReader(storage), KEY);
    expect(records).toEqual([
      { type: 'compat.counter.set', value: 3, time: 1700000000003 },
      { type: 'compat.tags.add', tag: 'a', time: 1700000000004 },
      { type: 'compat.tags.add', tag: 'b', time: 1700000000005 },
    ]);
    for (const record of records) {
      expect('payload' in record).toBe(false);
    }
    expect(await readRawLines(dir, KEY)).toEqual(records);

    const replayTarget = makeContainer(storage, 'replay-target');
    const withUnknown: WireRecord[] = [
      ...records,
      { type: 'compat.unknown.nope', foo: 1 },
    ];
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      await restoreTestEventDispatcher(
        replayTarget.dispatcher,
        replayTarget.log,
        testWireScope(SCOPE, 'replay-target'),
        withUnknown,
      );
    } finally {
      resetUnexpectedErrorHandler();
    }

    expect(unexpected).toHaveLength(1);
    expect(replayTarget.agentState.get(compatCounterKey)).toEqual(
      live.agentState.get(compatCounterKey),
    );
    expect(replayTarget.agentState.get(compatTagsKey)).toEqual(
      live.agentState.get(compatTagsKey),
    );
  });

  it('replays a v1.0-era journal through the full migration chain and heals it to the current version', async () => {
    const dir = await makeDir();
    const storage = new FileStorageService(dir);
    const seed = makeReader(storage);
    seed.append(testWireScope(SCOPE, 'legacy'), AGENT_WIRE_RECORD_KEY, {
      type: 'metadata',
      protocol_version: '1.0',
      created_at: 1,
    });
    seed.append(testWireScope(SCOPE, 'legacy'), AGENT_WIRE_RECORD_KEY, {
      type: 'tools.update_store',
      key: 'todo',
      value: [{ title: 'legacy todo', status: 'pending' }],
      time: 2,
    });
    seed.append(testWireScope(SCOPE, 'legacy'), AGENT_WIRE_RECORD_KEY, {
      type: 'compat.counter.set',
      value: 7,
      time: 3,
    });
    await seed.close();

    const legacy = makeContainer(storage, 'legacy');
    await legacy.dispatcher.restore();

    expect(legacy.agentState.get(compatCounterKey)).toEqual({ value: 7 });
    expect(legacy.agentState.get(todoKey)).toEqual([
      { title: 'legacy todo', status: 'pending' },
    ]);

    expect(await collect(makeReader(storage), 'legacy')).toEqual([
      { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [{ title: 'legacy todo', status: 'pending' }],
        time: 2,
      },
      { type: 'compat.counter.set', value: 7, time: 3 },
    ]);
  });
});
