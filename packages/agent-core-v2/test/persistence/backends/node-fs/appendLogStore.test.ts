import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdtempSync, rmSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { AppendLogCorruptedError, IAppendLogStore, type AppendLogTruncation } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
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
    writeStream: async () => {},
    append: async () => {},
    list: async () => [],
    delete: async () => {},
    size: async () => undefined,
    sizeSync: () => undefined,
    mtime: async () => undefined,
    pathFor: () => undefined,
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

  it('later flush reports an append conflict without retrying the batch', async () => {
    const failure = new Error('append failed after unexpected content appeared');
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let reportFailure!: (error: unknown) => void;
    const reportedFailure = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      markAppendStarted();
      await appendGate;
      await originalAppend(args[0], args[1], enc.encode('unexpected\n'), args[3]);
      throw failure;
    };

    record.append(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
    record.append(SCOPE, KEY, { n: 2 });
    await appendStarted;
    releaseAppend();
    expect(await reportedFailure).toBe(failure);

    await expect(record.flush()).rejects.toMatchObject({ code: 'storage.corrupted' });
    expect(appendAttempts).toBe(1);
    expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('unexpected\n');
  });

  it('reacquire after final release waits for retiring storage before fresh I/O', async () => {
    const failure = new Error('retiring append failed');
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let markReplacementAppendStarted!: () => void;
    const replacementAppendStarted = new Promise<void>((resolve) => {
      markReplacementAppendStarted = resolve;
    });
    let releaseReplacementAppend!: () => void;
    const replacementAppendGate = new Promise<void>((resolve) => {
      releaseReplacementAppend = resolve;
    });
    let reportFailure!: (error: unknown) => void;
    const reportedFailure = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    let appendAttempts = 0;
    let replacementStarted = false;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts === 1) {
        markAppendStarted();
        await appendGate;
        throw failure;
      }
      replacementStarted = true;
      markReplacementAppendStarted();
      await replacementAppendGate;
      return originalAppend(...args);
    };

    const retiringOwner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
    await appendStarted;
    retiringOwner.dispose();
    const replacementOwner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 2 });
    const orderedFlush = record.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(replacementStarted).toBe(false);

    releaseAppend();
    expect(await reportedFailure).toBe(failure);
    await replacementAppendStarted;

    const currentFlush = record.flush();
    let flushSettled = false;
    void currentFlush.then(() => {
      flushSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(flushSettled).toBe(false);

    releaseReplacementAppend();
    await Promise.all([orderedFlush, currentFlush]);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 2 }]);
    replacementOwner.dispose();
  });

  it('final release retirement is awaited by drainRetirements', async () => {
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      markAppendStarted();
      await appendGate;
      return originalAppend(...args);
    };

    const owner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 1 });
    await appendStarted;
    owner.dispose();

    let drained = false;
    const draining = record.drainRetirements().then(() => {
      drained = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseAppend();
    await draining;
    expect(drained).toBe(true);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);
  });

  it('recovers no-write and partial disk-full failures without releasing owners', async () => {
    const failure = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    let reportFailure!: (error: unknown) => void;
    const reportedFailure = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    let diskFull = true;
    let partialFailure = false;
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (diskFull) {
        if (partialFailure) {
          await originalAppend(args[0], args[1], args[2].subarray(0, 5), args[3]);
        }
        throw failure;
      }
      return originalAppend(...args);
    };

    const firstOwner = record.acquire(SCOPE, KEY);
    const finalOwner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
    expect(await reportedFailure).toBe(failure);

    firstOwner.dispose();
    await expect(record.flush()).rejects.toBe(failure);
    expect(appendAttempts).toBe(2);

    diskFull = false;
    record.append(SCOPE, KEY, { n: 2 });
    await record.flush();

    expect(appendAttempts).toBe(4);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);

    diskFull = true;
    partialFailure = true;
    record.append(SCOPE, KEY, { n: 3 });
    await expect(record.flush()).rejects.toBe(failure);

    const readFailure = new Error('recovery read failed');
    const originalReadStream = storage.readStream.bind(storage);
    let failRead = true;
    storage.readStream = async function* (scope, key, range) {
      if (failRead) throw readFailure;
      yield* originalReadStream(scope, key, range);
    };
    await expect(record.flush()).rejects.toBe(readFailure);
    expect(appendAttempts).toBe(5);

    failRead = false;
    diskFull = false;
    await record.flush();

    expect(appendAttempts).toBe(6);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    finalOwner.dispose();
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

  it('rewrite preserves an append whose old drain is in flight at cutover', async () => {
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseOldAppend!: () => void;
    const oldAppendGate = new Promise<void>((resolve) => {
      releaseOldAppend = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts === 1) {
        markAppendStarted();
        await oldAppendGate;
      }
      return originalAppend(...args);
    };
    const replacement = [{ n: 9 }];
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await appendStarted;

    const rewrite = record.rewrite<Rec>(SCOPE, KEY, replacement);
    const flushed = record.flush();
    releaseOldAppend();
    await flushed;
    await rewrite;

    expect(appendAttempts).toBe(2);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
  });

  it('explicit rewrite recovers an in-flight ambiguous append failure', async () => {
    const failure = new Error('append failed after commit');
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts === 1) {
        markAppendStarted();
        await appendGate;
        await originalAppend(...args);
        throw failure;
      }
      return originalAppend(...args);
    };
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await appendStarted;

    const rewrite = record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
    const flushed = record.flush();
    releaseAppend();
    await Promise.all([rewrite, flushed]);

    expect(appendAttempts).toBe(2);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
  });

  it('atomic rewrite rejection does not retry an append already written before cutover', async () => {
    const failure = new Error('atomic rewrite rejected');
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      markAppendStarted();
      await appendGate;
      return originalAppend(...args);
    };
    storage.write = async () => {
      throw failure;
    };
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await appendStarted;

    const rewriteRejected = expect(
      record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]),
    ).rejects.toBe(failure);
    releaseAppend();
    await rewriteRejected;

    await expect(record.flush()).rejects.toBe(failure);
    expect(appendAttempts).toBe(1);
    expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":2}\n');
  });

  it('invalid replacement records do not change append ownership', async () => {
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      markAppendStarted();
      await appendGate;
      return originalAppend(...args);
    };
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await appendStarted;

    const invalid = expect(
      record.rewrite<unknown>(SCOPE, KEY, [{ n: 9n }]),
    ).rejects.toBeInstanceOf(TypeError);
    releaseAppend();
    await invalid;
    await record.flush();

    expect(appendAttempts).toBe(1);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 2 }]);
  });

  it('successful explicit rewrite recovers sticky failure and drains the tail once', async () => {
    const failure = new Error('atomic rewrite rejected');
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts === 1) {
        markAppendStarted();
        await appendGate;
      }
      return originalAppend(...args);
    };
    let writeAttempts = 0;
    const originalWrite = storage.write.bind(storage);
    storage.write = async (...args) => {
      writeAttempts++;
      if (writeAttempts === 1) throw failure;
      return originalWrite(...args);
    };
    record.append<Rec>(SCOPE, KEY, { n: 2 });
    await appendStarted;

    const failedRewrite = expect(
      record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]),
    ).rejects.toBe(failure);
    releaseAppend();
    await failedRewrite;
    await expect(record.flush()).rejects.toBe(failure);
    await expect(collect<Rec>(SCOPE, KEY)).rejects.toBe(failure);
    await expect(record.close()).rejects.toBe(failure);

    await record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
    await record.flush();

    expect(writeAttempts).toBe(2);
    expect(appendAttempts).toBe(2);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
  });

  it('close waits for every key before reporting the first append failure', async () => {
    const failedScope = 'agents/a';
    const pendingScope = 'agents/b';
    const failure = new Error('first key failed');
    let reportFailure!: (error: unknown) => void;
    const reportedFailure = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    let markPendingAppendStarted!: () => void;
    const pendingAppendStarted = new Promise<void>((resolve) => {
      markPendingAppendStarted = resolve;
    });
    let releasePendingAppend!: () => void;
    const pendingAppendGate = new Promise<void>((resolve) => {
      releasePendingAppend = resolve;
    });
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      if (args[0] === failedScope) throw failure;
      if (args[0] === pendingScope) {
        markPendingAppendStarted();
        await pendingAppendGate;
      }
      return originalAppend(...args);
    };
    record.append(failedScope, KEY, { n: 1 }, { onError: reportFailure });
    expect(await reportedFailure).toBe(failure);
    record.append(pendingScope, KEY, { n: 2 });
    await pendingAppendStarted;

    const closed = record.close();
    let closeSettled = false;
    void closed.finally(() => {
      closeSettled = true;
    }).catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    releasePendingAppend();
    await expect(closed).rejects.toBe(failure);
    expect(new TextDecoder().decode(await storage.read(pendingScope, KEY))).toBe('{"n":2}\n');
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

  it('stops at a corrupted middle line and reports it when onTruncate is given', async () => {
    const raw = `${JSON.stringify({ n: 1 })}\nGARBAGE\n${JSON.stringify({ n: 3 })}\n`;
    await storage.append(SCOPE, KEY, enc.encode(raw));
    const truncations: AppendLogTruncation[] = [];

    const out: Rec[] = [];
    for await (const r of record.read<Rec>(SCOPE, KEY, {
      onTruncate: (truncation) => truncations.push(truncation),
    })) {
      out.push(r);
    }

    expect(out).toEqual([{ n: 1 }]);
    expect(truncations).toHaveLength(1);
    expect(truncations[0]).toMatchObject({ lineNumber: 2, reason: 'corrupted' });
    expect(truncations[0]!.cause).toBeInstanceOf(AppendLogCorruptedError);
  });

  it('reports a torn final line as truncation when onTruncate is given', async () => {
    const raw = `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 }).slice(0, 4)}`;
    await storage.append(SCOPE, KEY, enc.encode(raw));
    const truncations: AppendLogTruncation[] = [];

    const out: Rec[] = [];
    for await (const r of record.read<Rec>(SCOPE, KEY, {
      onTruncate: (truncation) => truncations.push(truncation),
    })) {
      out.push(r);
    }

    expect(out).toEqual([{ n: 1 }]);
    expect(truncations).toEqual([{ lineNumber: 2, reason: 'truncated' }]);
  });

  it('does not report truncation for a clean log when onTruncate is given', async () => {
    const raw = `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n`;
    await storage.append(SCOPE, KEY, enc.encode(raw));
    const truncations: AppendLogTruncation[] = [];

    const out: Rec[] = [];
    for await (const r of record.read<Rec>(SCOPE, KEY, {
      onTruncate: (truncation) => truncations.push(truncation),
    })) {
      out.push(r);
    }

    expect(out).toEqual([{ n: 1 }, { n: 2 }]);
    expect(truncations).toEqual([]);
  });

  it('reads across chunk boundaries (stream read splits lines)', async () => {
    const full = `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n${JSON.stringify({ n: 3 })}\n`;
    const bytes = enc.encode(full);
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
    const line1 = `${JSON.stringify({ type: 'metadata', protocol_version: '1.4' })}\n`;
    const line2 = `${JSON.stringify({ type: 'context.append_message', s: '中文中文中文' })}\n`;
    const bytes = enc.encode(line1 + line2);
    const cut = bytes.indexOf(enc.encode('中')[0]!) + 1;
    const chunks = [bytes.slice(0, cut), bytes.slice(cut)];
    const localIx = disposables.add(new TestInstantiationService());
    localIx.stub(IFileSystemStorageService, chunkedStorage(chunks));
    localIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log = localIx.get(IAppendLogStore);

    const first: Array<{ type: string }> = [];
    for await (const r of log.read<{ type: string }>(SCOPE, KEY)) {
      first.push(r);
      break;
    }
    expect(first).toEqual([{ type: 'metadata', protocol_version: '1.4' }]);

    const out: Array<{ type: string; s?: string }> = [];
    for await (const r of log.read<{ type: string; s?: string }>(SCOPE, KEY)) out.push(r);
    expect(out).toEqual([
      { type: 'metadata', protocol_version: '1.4' },
      { type: 'context.append_message', s: '中文中文中文' },
    ]);
  });

  it('isolates decoder state between concurrent reads', async () => {
    const content = `${JSON.stringify({ s: '中文日本語' })}\n`;
    const bytes = enc.encode(content);
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

  it('does not emit onDidWrite when a flush persists nothing', async () => {
    const events: string[] = [];
    record.onDidWrite((write) => events.push(`${write.scope}/${write.key}`));

    record.append<Rec>(SCOPE, KEY, { n: 1 });
    await record.flush();
    expect(events).toEqual([`${SCOPE}/${KEY}`]);

    await record.flush();
    await record.flush();
    expect(events).toEqual([`${SCOPE}/${KEY}`]);
  });

  it('emits onDidWrite only after a fully appended batch is synchronized', async () => {
    const events: string[] = [];
    record.onDidWrite((write) => events.push(`${write.scope}/${write.key}`));
    const original = storage.append.bind(storage);
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    let calls = 0;
    let retryData: Uint8Array | undefined;
    storage.append = async (scope, key, data, options) => {
      calls += 1;
      const result = await original(scope, key, data, options);
      if (calls === 1) record.append<Rec>(scope, key, { n: 2 });
      if (calls === 2) throw failure;
      if (calls === 3) retryData = data;
      return result;
    };

    record.append<Rec>(SCOPE, KEY, { n: 1 });
    await expect(record.flush()).rejects.toBe(failure);
    expect(events).toEqual([`${SCOPE}/${KEY}`]);

    await record.flush();

    expect(calls).toBe(3);
    expect(retryData?.byteLength).toBe(0);
    expect(events).toEqual([`${SCOPE}/${KEY}`, `${SCOPE}/${KEY}`]);
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
  });
});

describe('AppendLogStore session lock integration', () => {
  let homeDir: string;
  let disposables: DisposableStore;
  let storage: FileStorageService;
  let log: IAppendLogStore;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'append-log-lock-'));
    mkdirSync(join(homeDir, SCOPE), { recursive: true });
    disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    storage = new FileStorageService(homeDir);
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    log = ix.get(IAppendLogStore);
  });

  afterEach(() => {
    disposables.dispose();
    rmSync(homeDir, { recursive: true, force: true });
  });

  async function readAll(): Promise<void> {
    for await (const _ of log.read(SCOPE, KEY)) {
      void _;
    }
  }

  it('tracks external modification via known length', async () => {
    expect(log.externallyModified(SCOPE, KEY)).toBe(false);
    await readAll();
    expect(log.externallyModified(SCOPE, KEY)).toBe(false);

    appendFileSync(join(homeDir, SCOPE, KEY), `${JSON.stringify({ n: 1 })}\n`);
    expect(log.externallyModified(SCOPE, KEY)).toBe(true);

    await readAll();
    expect(log.externallyModified(SCOPE, KEY)).toBe(false);

    log.append<Rec>(SCOPE, KEY, { n: 2 });
    await log.flush();
    expect(log.externallyModified(SCOPE, KEY)).toBe(false);

    appendFileSync(join(homeDir, SCOPE, KEY), `${JSON.stringify({ n: 3 })}\n`);
    expect(log.externallyModified(SCOPE, KEY)).toBe(true);

    const failure = new Error('append failed after external modification');
    const originalAppend = storage.append.bind(storage);
    let failAppend = true;
    storage.append = async (...args) => {
      if (failAppend) throw failure;
      return originalAppend(...args);
    };
    log.append<Rec>(SCOPE, KEY, { n: 4 });
    await expect(log.flush()).rejects.toBe(failure);
    expect(log.externallyModified(SCOPE, KEY)).toBe(true);

    failAppend = false;
    await log.flush();
    expect(log.externallyModified(SCOPE, KEY)).toBe(true);

    await readAll();
    expect(log.externallyModified(SCOPE, KEY)).toBe(false);
  });

  it('does not treat bytes appended while reading as already consumed', async () => {
    const path = join(homeDir, SCOPE, KEY);
    writeFileSync(path, `${JSON.stringify({ n: 1 })}\n`);
    const originalReadStream = storage.readStream.bind(storage);
    storage.readStream = async function* (scope, key, range) {
      yield* originalReadStream(scope, key, range);
      appendFileSync(path, `${JSON.stringify({ n: 2 })}\n`);
    };

    await readAll();

    expect(log.externallyModified(SCOPE, KEY)).toBe(true);
  });

  it('resets known length after rewrite', async () => {
    log.append<Rec>(SCOPE, KEY, { n: 1 });
    await log.flush();
    await readAll();
    appendFileSync(join(homeDir, SCOPE, KEY), `${JSON.stringify({ n: 2 })}\n`);
    expect(log.externallyModified(SCOPE, KEY)).toBe(true);

    await log.rewrite<Rec>(SCOPE, KEY, [{ n: 3 }]);
    expect(log.externallyModified(SCOPE, KEY)).toBe(false);
  });

  it('keeps writes in memory while the session lock binding rejects, then flushes when released', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let acquired = false;
    const binding = log.bindWriteGuard(SCOPE, KEY, () => acquired);

    log.append<Rec>(SCOPE, KEY, { n: 1 });
    await log.flush();
    expect(existsSync(join(homeDir, SCOPE, KEY))).toBe(false);
    expect(warn).toHaveBeenCalledOnce();

    acquired = true;
    await log.flush();
    expect(existsSync(join(homeDir, SCOPE, KEY))).toBe(true);

    const out: Rec[] = [];
    for await (const r of log.read<Rec>(SCOPE, KEY)) out.push(r);
    expect(out).toEqual([{ n: 1 }]);
    binding.dispose();
    warn.mockRestore();
  });

  it('does not report external modification while an own append is in flight', async () => {
    const realAppend = storage.append.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.append = async (scope, key, data, options) => {
      await realAppend(scope, key, data, options);
      await gate;
    };

    await readAll();
    log.append<Rec>(SCOPE, KEY, { n: 1 });
    const flushing = log.flush();
    await vi.waitFor(() => {
      expect(existsSync(join(homeDir, SCOPE, KEY))).toBe(true);
    });
    expect(log.externallyModified(SCOPE, KEY)).toBe(false);
    release();
    await flushing;
    expect(log.externallyModified(SCOPE, KEY)).toBe(false);
  });

  it('does not report external modification before an own append lands', async () => {
    const realAppend = storage.append.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.append = async (scope, key, data, options) => {
      await gate;
      await realAppend(scope, key, data, options);
    };

    await readAll();
    log.append<Rec>(SCOPE, KEY, { n: 1 });
    const flushing = log.flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(log.externallyModified(SCOPE, KEY)).toBe(false);
    release();
    await flushing;
    expect(log.externallyModified(SCOPE, KEY)).toBe(false);
  });

  it('does not report external modification in the middle of a chunked append', async () => {
    const realAppend = storage.append.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.append = async (scope, key, data, options) => {
      const half = Math.floor(data.length / 2);
      await realAppend(scope, key, data.subarray(0, half), options);
      await gate;
      await realAppend(scope, key, data.subarray(half), options);
    };

    await readAll();
    log.append<Rec>(SCOPE, KEY, { n: 1234567 });
    const flushing = log.flush();
    await vi.waitFor(() => {
      expect(existsSync(join(homeDir, SCOPE, KEY))).toBe(true);
    });
    expect(log.externallyModified(SCOPE, KEY)).toBe(false);
    release();
    await flushing;
    expect(log.externallyModified(SCOPE, KEY)).toBe(false);
  });
  it('does not report external modification while an own rewrite is in flight', async () => {
    const realWrite = storage.write.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.write = async (scope, key, data, options) => {
      await realWrite(scope, key, data, options);
      await gate;
    };

    await readAll();
    const rewriting = log.rewrite<Rec>(SCOPE, KEY, [{ n: 1 }, { n: 2 }]);
    await vi.waitFor(() => {
      expect(existsSync(join(homeDir, SCOPE, KEY))).toBe(true);
    });
    expect(log.externallyModified(SCOPE, KEY)).toBe(false);
    release();
    await rewriting;
    expect(log.externallyModified(SCOPE, KEY)).toBe(false);
  });
});
