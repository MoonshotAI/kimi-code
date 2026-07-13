/**
 * Scenario: JSONL append-log ordering, durability, rewrite serialization, and decoding.
 *
 * Resolves the real `AppendLogStore` by interface over in-memory storage;
 * controlled storage promises expose write ordering without wall-clock waits.
 * Run with `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/persistence/backends/node-fs/appendLogStore.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { AppendLogCorruptedError, IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

const enc = new TextEncoder();

interface Rec {
  readonly n: number;
}

const SCOPE = 'agents/main';
const KEY = 'wire.jsonl';

function chunkedStorage(chunks: Uint8Array[]): IFileSystemStorageService {
  return {
    _serviceBrand: undefined,
    read: async () => undefined,
    readStream: async function* () {
      for (const c of chunks) yield c;
    },
    write: async () => {},
    append: async () => {},
    list: async () => [],
    delete: async () => {},
    flush: async () => {},
    close: async () => {},
  };
}

describe('AppendLogStore', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let storage: InMemoryStorageService;
  let record: IAppendLogStore;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    storage = new InMemoryStorageService();
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    record = ix.get(IAppendLogStore);
  });

  afterEach(() => disposables.dispose());

  async function collect<R>(scope: string, key: string): Promise<readonly R[]> {
    const out: R[] = [];
    for await (const r of record.read<R>(scope, key)) {
      out.push(r);
    }
    return out;
  }

  it('reads nothing from an empty log', async () => {
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([]);
  });

  it('append + read round-trips records in order', async () => {
    record.append<Rec>(SCOPE, KEY, { n: 1 });
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    record.append<Rec>(SCOPE, KEY, { n: 3 });
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('batches many appends into a single durable append', async () => {
    const spy = { count: 0 };
    const original = storage.append.bind(storage);
    storage.append = async (...args) => {
      spy.count++;
      return original(...args);
    };

    for (let n = 0; n < 10; n++) record.append<Rec>(SCOPE, KEY, { n });
    await record.flush();

    expect(await collect<Rec>(SCOPE, KEY)).toHaveLength(10);
    expect(spy.count).toBe(1);
  });

  it('rewrite atomically replaces the whole log', async () => {
    record.append<Rec>(SCOPE, KEY, { n: 1 });
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await record.flush();

    await record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }, { n: 8 }]);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 8 }]);
  });

  it('rewrite preserves an append accepted after the replacement snapshot', async () => {
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const originalWrite = storage.write.bind(storage);
    storage.write = async (...args) => {
      markWriteStarted();
      await writeGate;
      return originalWrite(...args);
    };
    const replacement = [{ n: 9 }];
    record.append<Rec>(SCOPE, KEY, { n: 2 });

    const rewrite = record.rewrite<Rec>(SCOPE, KEY, replacement);
    await writeStarted;
    const flushed = record.flush();
    releaseWrite();
    await flushed;

    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
    await rewrite;
  });

  it('appends that arrive during a rewrite land after the replaced content', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const originalWrite = storage.write.bind(storage);
    storage.write = async (...args) => {
      await writeGate;
      return originalWrite(...args);
    };

    record.append<Rec>(SCOPE, KEY, { n: 1 });
    await record.flush();
    const rewrite = record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    releaseWrite();
    await rewrite;
    await record.flush();

    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
  });

  it('flush() awaits an in-flight rewrite', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const originalWrite = storage.write.bind(storage);
    storage.write = async (...args) => {
      await writeGate;
      return originalWrite(...args);
    };

    record.append<Rec>(SCOPE, KEY, { n: 1 });
    await record.flush();
    const rewrite = record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
    const flushed = record.flush();
    releaseWrite();
    await flushed;
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }]);
    await rewrite;
  });

  it('flush() stays pending until an append made during rewrite is durable', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const originalWrite = storage.write.bind(storage);
    storage.write = async (...args) => {
      await writeGate;
      return originalWrite(...args);
    };
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      markAppendStarted();
      await appendGate;
      return originalAppend(...args);
    };

    const rewrite = record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    const flushed = record.flush();
    let flushSettled = false;
    void flushed.then(() => {
      flushSettled = true;
    });

    releaseWrite();
    await appendStarted;
    await Promise.resolve();
    await Promise.resolve();
    expect(flushSettled).toBe(false);

    releaseAppend();
    await flushed;
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
    await rewrite;
  });

  it('logs addressed by different scope/key are independent', async () => {
    record.append<Rec>('a', 'l', { n: 1 });
    record.append<Rec>('b', 'l', { n: 2 });
    expect(await collect<Rec>('a', 'l')).toEqual([{ n: 1 }]);
    expect(await collect<Rec>('b', 'l')).toEqual([{ n: 2 }]);
  });

  it('drops a torn final line (crash mid-flush)', async () => {
    // One complete record + a half-written trailing record with no newline.
    const raw = `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 }).slice(0, 4)}`;
    await storage.append(SCOPE, KEY, enc.encode(raw));

    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);
  });

  it('throws AppendLogCorruptedError on a corrupted middle line', async () => {
    const raw = `${JSON.stringify({ n: 1 })}\nGARBAGE\n${JSON.stringify({ n: 3 })}\n`;
    await storage.append(SCOPE, KEY, enc.encode(raw));

    await expect(collect<Rec>(SCOPE, KEY)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AppendLogCorruptedError);
      const corrupted = error as AppendLogCorruptedError;
      expect(corrupted.code).toBe('storage.corrupted');
      expect(corrupted.details).toEqual({ scope: SCOPE, key: KEY, lineNumber: 2 });
      expect(corrupted.cause).toBeInstanceOf(SyntaxError);
      return true;
    });
  });

  it('reads across chunk boundaries (stream read splits lines)', async () => {
    const full = `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n${JSON.stringify({ n: 3 })}\n`;
    const bytes = enc.encode(full);
    // Split into chunks that cut through the middle of lines.
    const chunks = [bytes.slice(0, 7), bytes.slice(7, 23), bytes.slice(23)];
    const localIx = disposables.add(new TestInstantiationService());
    localIx.stub(IFileSystemStorageService, chunkedStorage(chunks));
    localIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log = localIx.get(IAppendLogStore);

    const out: Rec[] = [];
    for await (const r of log.read<Rec>(SCOPE, KEY)) out.push(r);
    expect(out).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('does not leak decoder state into a later read when an earlier read returns early', async () => {
    // Regression for fork: `TextDecoder` in `stream` mode buffers a trailing
    // incomplete multi-byte sequence. When a read returns early — the way
    // `ensureWireMetadata` bails as soon as it sees the leading `metadata`
    // record — it skips the final flushing `decode()`. A shared decoder would
    // then carry that buffered sequence into the next read and prepend a
    // U+FFFD to its first line, corrupting the `metadata` record
    // (`append-log ...: corrupted line 1`) and breaking session fork.
    const line1 = `${JSON.stringify({ type: 'metadata', protocol_version: '1.4' })}\n`;
    const line2 = `${JSON.stringify({ type: 'context.append_message', s: '中文中文中文' })}\n`;
    const bytes = enc.encode(line1 + line2);
    // Split the first chunk through the middle of a '中' (3-byte UTF-8) in
    // line2 so the decoder buffers an incomplete sequence when line1 is read.
    const cut = bytes.indexOf(enc.encode('中')[0]!) + 1;
    const chunks = [bytes.slice(0, cut), bytes.slice(cut)];
    const localIx = disposables.add(new TestInstantiationService());
    localIx.stub(IFileSystemStorageService, chunkedStorage(chunks));
    localIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log = localIx.get(IAppendLogStore);

    // First read: consume only the leading metadata record, then return early.
    const first: Array<{ type: string }> = [];
    for await (const r of log.read<{ type: string }>(SCOPE, KEY)) {
      first.push(r);
      break;
    }
    expect(first).toEqual([{ type: 'metadata', protocol_version: '1.4' }]);

    // Second read: must start cleanly — no U+FFFD leaked from the first read.
    const out: Array<{ type: string; s?: string }> = [];
    for await (const r of log.read<{ type: string; s?: string }>(SCOPE, KEY)) out.push(r);
    expect(out).toEqual([
      { type: 'metadata', protocol_version: '1.4' },
      { type: 'context.append_message', s: '中文中文中文' },
    ]);
  });

  it('isolates decoder state between concurrent reads', async () => {
    // Two reads of the same multi-byte content must not interfere with each
    // other through a shared decoder: each read owns its decoder state.
    const content = `${JSON.stringify({ s: '中文日本語' })}\n`;
    const bytes = enc.encode(content);
    // One byte per chunk to maximize the chance of mid-character splits.
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
    const localIx = disposables.add(new TestInstantiationService());
    localIx.stub(IFileSystemStorageService, chunkedStorage(chunks));
    localIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log = localIx.get(IAppendLogStore);

    const readAll = async (): Promise<Array<{ s: string }>> => {
      const out: Array<{ s: string }> = [];
      for await (const r of log.read<{ s: string }>(SCOPE, KEY)) out.push(r);
      return out;
    };
    const [a, b] = await Promise.all([readAll(), readAll()]);
    expect(a).toEqual([{ s: '中文日本語' }]);
    expect(b).toEqual([{ s: '中文日本語' }]);
  });

  it('reads across chunk boundaries with multi-byte UTF-8 split', async () => {
    const full = `${JSON.stringify({ n: 1, s: '中文' })}\n${JSON.stringify({ n: 2, s: '日本語' })}\n`;
    const bytes = enc.encode(full);
    // Split at every byte to maximally stress multi-byte decode across chunks.
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
    const localIx = disposables.add(new TestInstantiationService());
    localIx.stub(IFileSystemStorageService, chunkedStorage(chunks));
    localIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log = localIx.get(IAppendLogStore);

    const out: Array<Rec & { s?: string }> = [];
    for await (const r of log.read<Rec & { s?: string }>(SCOPE, KEY)) out.push(r);
    expect(out).toEqual([
      { n: 1, s: '中文' },
      { n: 2, s: '日本語' },
    ]);
  });
});
