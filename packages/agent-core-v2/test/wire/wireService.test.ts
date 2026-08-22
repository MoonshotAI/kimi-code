import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { resetUnexpectedErrorHandler, setUnexpectedErrorHandler } from '#/_base/errors/unexpectedError';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import type { ContentPart } from '#/kosong/contract/message';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService, StorageError, StorageErrors } from '#/persistence/interface/storage';
import { WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { recordingWireLog, registerTestAgentWire, testWireScope } from './stubs';

const SCOPE = 'wire';
const KEY = 'journal-test';

let disposables: DisposableStore;
let ix: TestInstantiationService;
let wire: IWireService;
let log: IAppendLogStore;

beforeEach(() => {
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  log = ix.get(IAppendLogStore);
  wire = registerTestAgentWire(ix, testWireScope(SCOPE, KEY), { log });
});

afterEach(() => disposables.dispose());

async function readRecords(
  target: IAppendLogStore = log,
  scope = SCOPE,
  key = KEY,
): Promise<WireRecord[]> {
  const out: WireRecord[] = [];
  for await (const record of target.read<WireRecord>(testWireScope(scope, key), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

async function collect(journal: AsyncIterable<WireRecord>): Promise<WireRecord[]> {
  const out: WireRecord[] = [];
  for await (const record of journal) {
    out.push(record);
  }
  return out;
}

function wireOverLog(
  stubLog: IAppendLogStore,
  key: string,
  dependencies: { blob?: IAgentBlobService } = {},
): IWireService {
  const stubIx = disposables.add(new TestInstantiationService());
  return registerTestAgentWire(stubIx, testWireScope(SCOPE, key), { log: stubLog, ...dependencies });
}

describe('WireService seal', () => {
  it('writes the metadata envelope once and ignores repeated calls', async () => {
    await wire.seal();
    await wire.seal();

    expect(await readRecords()).toEqual([
      {
        type: 'metadata',
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: expect.any(Number),
      },
    ]);
  });

  it('does not seal a journal that already has records', async () => {
    log.append(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY, {
      type: 'wire.test.existing',
      time: 1,
    });
    await log.flush();

    await wire.seal();

    expect(await readRecords()).toEqual([{ type: 'wire.test.existing', time: 1 }]);
  });
});

describe('WireService appendRecord', () => {
  it('appends flat records without a dehydrator', async () => {
    wire.appendRecord({ type: 'wire.test.append', value: 1, time: 10 });
    wire.appendRecord({ type: 'wire.test.append', value: 2, time: 11 });

    expect(await readRecords()).toEqual([
      { type: 'wire.test.append', value: 1, time: 10 },
      { type: 'wire.test.append', value: 2, time: 11 },
    ]);
  });

  it('runs records through the dehydrate queue in append order', async () => {
    const order: string[] = [];
    wire.appendRecord({ type: 'wire.test.a', time: 1 }, async (record) => {
      order.push('a');
      return { ...record, dehydrated: true };
    });
    wire.appendRecord({ type: 'wire.test.b', time: 2 }, async (record) => {
      order.push('b');
      return record;
    });
    await wire.flush();

    expect(order).toEqual(['a', 'b']);
    expect(await readRecords()).toEqual([
      { type: 'wire.test.a', time: 1, dehydrated: true },
      { type: 'wire.test.b', time: 2 },
    ]);
  });

  it('queues a plain append behind a pending dehydrate', async () => {
    const records: WireRecord[] = [];
    const queued = wireOverLog(recordingWireLog(records), 'queued');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    queued.appendRecord({ type: 'wire.test.gated', time: 1 }, async (record) => {
      await gate;
      return record;
    });
    queued.appendRecord({ type: 'wire.test.plain', time: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(records).toEqual([]);

    release();
    await queued.flush();
    expect(records).toEqual([
      { type: 'wire.test.gated', time: 1 },
      { type: 'wire.test.plain', time: 2 },
    ]);
  });

  it('hands the dehydrator a blob offload transform backed by the blob service', async () => {
    const offloaded: unknown[][] = [];
    const blob: IAgentBlobService = {
      _serviceBrand: undefined,
      offloadParts: async (parts) => {
        offloaded.push([...parts]);
        return parts.map((part) => ({ type: 'blob_ref', part })) as unknown as ContentPart[];
      },
      loadParts: async (parts) => parts,
      isBlobRef: () => false,
    };
    const records: WireRecord[] = [];
    const withBlob = wireOverLog(recordingWireLog(records), 'blob', { blob });

    withBlob.appendRecord(
      { type: 'wire.test.blob', parts: [{ type: 'text', text: 'x' }], time: 1 },
      async (record, transform) => ({
        ...record,
        parts: await transform(record['parts'] as readonly unknown[]),
      }),
    );
    await withBlob.flush();

    expect(offloaded).toEqual([[{ type: 'text', text: 'x' }]]);
    expect(records).toEqual([
      {
        type: 'wire.test.blob',
        parts: [{ type: 'blob_ref', part: { type: 'text', text: 'x' } }],
        time: 1,
      },
    ]);
  });

  it('reports a synchronous append failure through onUnexpectedError instead of throwing', () => {
    const expected = new Error('append exploded');
    const failing = recordingWireLog([]);
    failing.append = () => {
      throw expected;
    };
    const stub = wireOverLog(failing, 'failing');

    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      stub.appendRecord({ type: 'wire.test.fail', time: 1 });
      expect(unexpected).toEqual([expected]);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('reports a dehydrate failure and keeps the queue usable for later appends', async () => {
    const expected = new Error('dehydrate exploded');
    const records: WireRecord[] = [];
    const stub = wireOverLog(recordingWireLog(records), 'dehydrate-fail');

    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      stub.appendRecord({ type: 'wire.test.bad', time: 1 }, async () => {
        throw expected;
      });
      stub.appendRecord({ type: 'wire.test.good', time: 2 });
      await stub.flush();

      expect(unexpected).toEqual([expected]);
      expect(records).toEqual([{ type: 'wire.test.good', time: 2 }]);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });
});

describe('WireService readJournal', () => {
  it('bootstraps the metadata envelope onto an empty journal', async () => {
    expect(await collect(wire.readJournal())).toEqual([]);

    expect(await readRecords()).toEqual([
      {
        type: 'metadata',
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: expect.any(Number),
      },
    ]);
  });

  it('heals an envelope-less legacy journal through the v1.4 to v1.5 migration', async () => {
    log.append(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY, {
      type: 'goal.create',
      goalId: 'g1',
      objective: 'legacy',
      time: 7,
    });
    await log.flush();

    const yielded = await collect(wire.readJournal());

    expect(yielded).toEqual([
      {
        type: 'goal.create',
        goalId: 'g1',
        objective: 'legacy',
        time: 7,
        wallClockResumedAt: 7,
      },
    ]);
    expect(await readRecords()).toEqual([
      {
        type: 'metadata',
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: expect.any(Number),
      },
      ...yielded,
    ]);
  });

  it('migrates a v1.4 journal and rewrites it at the current protocol version', async () => {
    log.append(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY, {
      type: 'metadata',
      protocol_version: '1.4',
      created_at: 1,
    });
    log.append(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY, {
      type: 'goal.create',
      goalId: 'g1',
      time: 9,
    });
    await log.flush();

    const yielded = await collect(wire.readJournal());

    expect(yielded).toEqual([
      { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'goal.create', goalId: 'g1', time: 9, wallClockResumedAt: 9 },
    ]);
    expect(await readRecords()).toEqual(yielded);
  });

  it('reads a current-version journal without rewriting it', async () => {
    const seeded: WireRecord[] = [
      { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'wire.test.current', value: 1, time: 2 },
    ];
    let rewrites = 0;
    const counting = recordingWireLog(seeded);
    const rewrite = counting.rewrite.bind(counting);
    counting.rewrite = async (scope, key, next) => {
      rewrites += 1;
      return rewrite(scope, key, next);
    };
    const stub = wireOverLog(counting, 'current');

    expect(await collect(stub.readJournal())).toEqual(seeded);
    expect(rewrites).toBe(0);
  });

  it('reads a newer-version journal without stamping or rewriting it', async () => {
    const seeded: WireRecord[] = [
      { type: 'metadata', protocol_version: '9.9', created_at: 1 },
      { type: 'wire.test.newer', value: 1, time: 2 },
    ];
    let rewrites = 0;
    const counting = recordingWireLog(seeded);
    const rewrite = counting.rewrite.bind(counting);
    counting.rewrite = async (scope, key, next) => {
      rewrites += 1;
      return rewrite(scope, key, next);
    };
    const stub = wireOverLog(counting, 'newer');

    expect(await collect(stub.readJournal())).toEqual(seeded);
    expect(rewrites).toBe(0);
  });

  it('rejects a malformed metadata envelope as corrupted storage', async () => {
    const stub = wireOverLog(
      recordingWireLog([{ type: 'metadata' }]),
      'malformed-metadata',
    );

    const failure = await collect(stub.readJournal()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).toMatchObject({
      code: StorageErrors.codes.STORAGE_CORRUPTED,
    });
  });

  it('skips malformed lines and reports them through onUnexpectedError', async () => {
    const seeded: WireRecord[] = [
      'garbage' as unknown as WireRecord,
      { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
      42 as unknown as WireRecord,
      { type: 'wire.test.ok', time: 3 },
    ];
    const stub = wireOverLog(recordingWireLog(seeded), 'malformed-lines');

    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      const yielded = await collect(stub.readJournal());

      expect(yielded).toEqual([
        { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
        { type: 'wire.test.ok', time: 3 },
      ]);
      expect(unexpected).toHaveLength(2);
      expect(unexpected[0]).toMatchObject({
        code: 'wire.unknown_record',
        details: { type: undefined, index: 0 },
      });
      expect(unexpected[1]).toMatchObject({
        code: 'wire.unknown_record',
        details: { type: undefined, index: 1 },
      });
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('throws when the journal version has no migration path', async () => {
    const stub = wireOverLog(
      recordingWireLog([{ type: 'metadata', protocol_version: '0.9', created_at: 1 }]),
      'no-migration',
    );

    await expect(collect(stub.readJournal())).rejects.toThrow(
      'Missing wire migration for version 0.9',
    );
  });
});

describe('WireService flush', () => {
  it('drains the dehydrate queue before resolving', async () => {
    const records: WireRecord[] = [];
    const stub = wireOverLog(recordingWireLog(records), 'flush');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    stub.appendRecord({ type: 'wire.test.gated', time: 1 }, async (record) => {
      await gate;
      return record;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(records).toEqual([]);

    let flushed = false;
    const flushPromise = stub.flush().then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(flushed).toBe(false);

    release();
    await flushPromise;
    expect(flushed).toBe(true);
    expect(records).toEqual([{ type: 'wire.test.gated', time: 1 }]);
  });
});
