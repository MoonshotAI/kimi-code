import { mkdtempSync, rmSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { AppendLogCorruptedError, IAppendLogStore, type AppendLogTruncation } from '#/persistence/interface/appendLogStore';
import { ISessionLockService } from '#/persistence/interface/sessionLock';
import { IFileSystemStorageService, StorageError, StorageErrors } from '#/persistence/interface/storage';
import { InMemorySessionLockService } from '#/persistence/backends/memory/sessionLockService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { SessionLockService } from '#/persistence/backends/node-fs/sessionLockService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

import { stubLog } from '../../../_base/log/stubs';

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
    ix.stub(ILogService, stubLog());
    ix.stub(ISessionLockService, new InMemorySessionLockService());
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

  it('later flush reports an ambiguous auto-flush failure without retrying the batch', async () => {
    const failure = new Error('append failed after commit');
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
      await originalAppend(...args);
      throw failure;
    };

    record.append(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
    record.append(SCOPE, KEY, { n: 2 });
    await appendStarted;
    releaseAppend();
    expect(await reportedFailure).toBe(failure);

    await expect(record.flush()).rejects.toBe(failure);
    expect(appendAttempts).toBe(1);
    expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(
      '{"n":1}\n{"n":2}\n',
    );
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

  it('keeps a sticky failure until every acquired owner releases it', async () => {
    const failure = new Error('shared append failed');
    let reportFailure!: (error: unknown) => void;
    const reportedFailure = new Promise<unknown>((resolve) => {
      reportFailure = resolve;
    });
    let appendAttempts = 0;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (...args) => {
      appendAttempts++;
      if (appendAttempts === 1) throw failure;
      return originalAppend(...args);
    };

    const firstOwner = record.acquire(SCOPE, KEY);
    const finalOwner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
    expect(await reportedFailure).toBe(failure);

    firstOwner.dispose();
    await expect(record.flush()).rejects.toBe(failure);

    finalOwner.dispose();
    const replacementOwner = record.acquire(SCOPE, KEY);
    record.append(SCOPE, KEY, { n: 2 });
    await record.flush();
    expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 2 }]);
    replacementOwner.dispose();
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

  it.each(['committed', 'committed then rejected'] as const)(
    'a handled rewrite failure does not replay an append that %s before cutover',
    async (outcome) => {
      const failure = new Error('atomic rewrite rejected');
      let started!: () => void;
      const appendStarted = new Promise<void>((resolve) => { started = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const originalAppend = storage.append.bind(storage);
      let attempts = 0;
      storage.append = async (...args) => {
        attempts++;
        started();
        await gate;
        await originalAppend(...args);
        if (outcome === 'committed then rejected') throw new Error('append durability uncertain');
      };
      const originalWrite = storage.write.bind(storage);
      storage.write = async () => { throw failure; };
      const onError = vi.fn(() => { record.append(SCOPE, KEY, { n: 3 }); });
      record.append(SCOPE, KEY, { n: 2 });
      await appendStarted;
      const rewriting = record.rewrite(SCOPE, KEY, [{ n: 9 }], { onError });
      release();
      await rewriting;
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
      await expect(record.flush()).rejects.toBe(failure);
      expect(attempts).toBe(1);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":2}\n');
      storage.append = originalAppend;
      storage.write = originalWrite;
      await record.rewrite(SCOPE, KEY, [{ n: 9 }]);
      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }, { n: 3 }]);
    },
  );

  it('propagates errors thrown by a rewrite error handler', async () => {
    const failure = new Error('atomic rewrite rejected');
    const callbackFailure = new Error('error handler rejected');
    storage.write = async () => { throw failure; };
    await expect(record.rewrite(SCOPE, KEY, [{ n: 9 }], {
      onError: () => { throw callbackFailure; },
    })).rejects.toBe(callbackFailure);
    await expect(record.flush()).rejects.toBe(failure);
  });

  it('does not hide a tail append failure after a successful rewrite with an error handler', async () => {
    const failure = new Error('tail append rejected');
    const originalWrite = storage.write.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    storage.write = async (...args) => { await gate; return originalWrite(...args); };
    storage.append = async () => { throw failure; };
    const onError = vi.fn();
    const rewriting = record.rewrite(SCOPE, KEY, [{ n: 9 }], { onError });
    record.append(SCOPE, KEY, { n: 2 });
    release();
    await expect(rewriting).rejects.toBe(failure);
    expect(onError).not.toHaveBeenCalled();
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

  it('close waits for every key before reporting the first sticky failure', async () => {
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
    localIx.stub(ILogService, stubLog());
    localIx.stub(ISessionLockService, new InMemorySessionLockService());
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
    localIx.stub(ILogService, stubLog());
    localIx.stub(ISessionLockService, new InMemorySessionLockService());
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
    localIx.stub(ILogService, stubLog());
    localIx.stub(ISessionLockService, new InMemorySessionLockService());
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
    localIx.stub(ILogService, stubLog());
    localIx.stub(ISessionLockService, new InMemorySessionLockService());
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

  it('emits onDidWrite for batches persisted before a later drain failure', async () => {
    const events: string[] = [];
    record.onDidWrite((write) => events.push(`${write.scope}/${write.key}`));
    const original = storage.append.bind(storage);
    let calls = 0;
    storage.append = async (scope, key, data, options) => {
      calls += 1;
      if (calls > 1) throw new Error('disk full');
      const result = await original(scope, key, data, options);
      record.append<Rec>(scope, key, { n: 2 });
      return result;
    };

    record.append<Rec>(SCOPE, KEY, { n: 1 });
    await expect(record.flush()).rejects.toThrow('disk full');
    expect(events).toEqual([`${SCOPE}/${KEY}`]);
  });

  describe('disk-full recovery', () => {
    const diskFull = (): StorageError =>
      new StorageError(
        StorageErrors.codes.STORAGE_DISK_FULL,
        'storage append failed: no space left on device',
        { details: { errno: 'ENOSPC' } },
      );

    const settle = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function watchRecovery(): Promise<void> {
      return new Promise<void>((resolve) => {
        const subscription = record.onDidRecover((write) => {
          if (write.scope === SCOPE && write.key === KEY) {
            subscription.dispose();
            resolve();
          }
        });
      });
    }

    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((settle) => {
        resolve = settle;
      });
      return { promise, resolve };
    }

    function trackWriteLeases() {
      const active = new Set<{ disposeCalls: number }>();
      const leases: { disposeCalls: number }[] = [];
      const guard = vi.fn(() => {
        const lease = { disposeCalls: 0 };
        leases.push(lease);
        active.add(lease);
        return {
          dispose: () => {
            lease.disposeCalls++;
            active.delete(lease);
          },
        };
      });
      return { active, leases, guard };
    }

    it.each([
      { phase: 'initial drain', trigger: 2 },
      { phase: 'recovery dispatch', trigger: 3 },
      { phase: 'recovery reconciliation', trigger: 4 },
    ])('a reentrant guard rewrite during $phase keeps its lease and accepted records', async ({ phase, trigger }) => {
      const leases = trackWriteLeases();
      const failure = diskFull();
      const reported = deferred<unknown>();
      const rewriteStarted = deferred<void>();
      const rewriteGate = deferred<void>();
      let guardCalls = 0;
      let rewriteTriggered = false;
      let rewriting: Promise<void> | undefined;
      disposables.add(record.bindWriteGuard(SCOPE, KEY, () => {
        guardCalls++;
        if (guardCalls === trigger && !rewriteTriggered) {
          rewriteTriggered = true;
          rewriting = record.rewrite(SCOPE, KEY, [{ n: 9 }]);
          return leases.guard();
        }
        return true;
      }));
      const originalAppend = storage.append.bind(storage);
      const originalWrite = storage.write.bind(storage);
      const appended: Uint8Array[] = [];
      storage.append = async (...args) => {
        appended.push(args[2].slice());
        if (phase !== 'initial drain' && appended.length === 1) throw failure;
        return originalAppend(...args);
      };
      storage.write = async (...args) => {
        rewriteStarted.resolve();
        await rewriteGate.promise;
        return originalWrite(...args);
      };

      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      let closing: Promise<void> | undefined;
      if (phase !== 'initial drain') {
        expect(await reported.promise).toBe(failure);
        closing = record.close();
      }
      await rewriteStarted.promise;
      if (closing === undefined) closing = record.close();
      await settle();
      expect.soft(leases.active.size).toBe(1);
      expect.soft(leases.leases).toEqual([{ disposeCalls: 0 }]);
      expect.soft(appended).toEqual(phase === 'initial drain' ? [] : [enc.encode('{"n":1}\n')]);
      expect.soft(await storage.read(SCOPE, KEY)).toBeUndefined();
      rewriteGate.resolve();
      await Promise.all([closing, rewriting]);
      await record.flush();

      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":9}\n{"n":1}\n');
      expect(appended).toEqual(phase === 'initial drain'
        ? [enc.encode('{"n":1}\n')]
        : [enc.encode('{"n":1}\n'), enc.encode('{"n":1}\n')]);
      expect(leases.leases).toEqual([{ disposeCalls: 1 }]);
      expect(leases.active.size).toBe(0);
    });

    it('holds a write-guard lease across an asynchronous standalone rewrite and its accepted tail', async () => {
      const leases = trackWriteLeases();
      disposables.add(record.bindWriteGuard(SCOPE, KEY, leases.guard));
      const started = deferred<void>();
      const gate = deferred<void>();
      const originalWrite = storage.write.bind(storage);
      const originalAppend = storage.append.bind(storage);
      const activeDuringWrite: number[] = [];
      storage.write = async (...args) => {
        started.resolve();
        await gate.promise;
        activeDuringWrite.push(leases.active.size);
        return originalWrite(...args);
      };
      storage.append = async (...args) => {
        activeDuringWrite.push(leases.active.size);
        return originalAppend(...args);
      };

      const rewriting = record.rewrite(SCOPE, KEY, [{ n: 9 }]);
      await started.promise;
      expect(leases.active.size).toBe(1);
      expect(leases.leases).toEqual([{ disposeCalls: 0 }]);
      record.append(SCOPE, KEY, { n: 2 });
      gate.resolve();
      await rewriting;

      expect(activeDuringWrite).toEqual([1, 1]);
      expect(leases.leases).toEqual([{ disposeCalls: 1 }]);
      expect(leases.active.size).toBe(0);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":9}\n{"n":2}\n');
    });

    it('transfers the same write lease from an in-flight append to its replacing rewrite', async () => {
      const leases = trackWriteLeases();
      disposables.add(record.bindWriteGuard(SCOPE, KEY, leases.guard));
      const appendStarted = deferred<void>();
      const appendGate = deferred<void>();
      const rewriteStarted = deferred<void>();
      const rewriteGate = deferred<void>();
      const originalAppend = storage.append.bind(storage);
      const originalWrite = storage.write.bind(storage);
      const activeDuringWrite: number[] = [];
      storage.append = async (...args) => {
        appendStarted.resolve();
        await appendGate.promise;
        activeDuringWrite.push(leases.active.size);
        return originalAppend(...args);
      };
      storage.write = async (...args) => {
        rewriteStarted.resolve();
        await rewriteGate.promise;
        activeDuringWrite.push(leases.active.size);
        return originalWrite(...args);
      };

      record.append(SCOPE, KEY, { n: 1 });
      await appendStarted.promise;
      expect(leases.active.size).toBe(1);
      const rewriting = record.rewrite(SCOPE, KEY, [{ n: 9 }]);
      record.append(SCOPE, KEY, { n: 2 });
      expect(leases.leases).toEqual([{ disposeCalls: 0 }]);
      appendGate.resolve();
      await rewriteStarted.promise;
      expect(leases.active.size).toBe(1);
      expect(leases.leases).toEqual([{ disposeCalls: 0 }]);
      rewriteGate.resolve();
      await rewriting;

      expect(activeDuringWrite).toEqual([1, 1, 1]);
      expect(leases.leases).toEqual([{ disposeCalls: 1 }]);
      expect(leases.active.size).toBe(0);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":9}\n{"n":1}\n{"n":2}\n');
    });

    it('rejects a guarded rewrite without writing and keeps the failure until an explicit retry', async () => {
      await storage.append(SCOPE, KEY, enc.encode('{"n":0}\n'));
      await collect(SCOPE, KEY);
      const leases = trackWriteLeases();
      let acquired = false;
      disposables.add(record.bindWriteGuard(SCOPE, KEY, () => acquired ? leases.guard() : false));
      const writes = vi.spyOn(storage, 'write');

      await expect(record.rewrite(SCOPE, KEY, [{ n: 9 }])).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_LOCKED,
      });
      await expect(record.flush()).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_LOCKED });
      expect(writes).not.toHaveBeenCalled();
      expect(leases.leases).toEqual([]);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":0}\n');
      acquired = true;
      await record.rewrite(SCOPE, KEY, [{ n: 9 }]);
      await record.flush();

      expect(writes).toHaveBeenCalledOnce();
      expect(leases.leases).toEqual([{ disposeCalls: 1 }]);
      expect(leases.active.size).toBe(0);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":9}\n');
    });

    it('holds a write-guard lease across asynchronous writes in one healthy batch', async () => {
      const leases = trackWriteLeases();
      disposables.add(record.bindWriteGuard(SCOPE, KEY, leases.guard));
      const reads = vi.spyOn(storage, 'readStream');
      const started = deferred<void>();
      const gate = deferred<void>();
      const originalAppend = storage.append.bind(storage);
      const activeDuringAppend: number[] = [];
      storage.append = async (...args) => {
        started.resolve();
        await gate.promise;
        activeDuringAppend.push(leases.active.size);
        return originalAppend(...args);
      };

      record.append(SCOPE, KEY, { n: 1 });
      await started.promise;
      expect(leases.active.size).toBe(1);
      record.append(SCOPE, KEY, { n: 2 });
      const flushed = record.flush();
      gate.resolve();
      await flushed;

      expect(activeDuringAppend).toEqual([1, 1]);
      expect(reads).not.toHaveBeenCalled();
      expect(leases.leases).toEqual([{ disposeCalls: 1 }]);
      expect(leases.active.size).toBe(0);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n{"n":2}\n');
    });

    it('releases a failed append lease before acquiring the recovery lease', async () => {
      await collect(SCOPE, KEY);
      const leases = trackWriteLeases();
      disposables.add(record.bindWriteGuard(SCOPE, KEY, leases.guard));
      const failure = diskFull();
      const reported = deferred<unknown>();
      const started = deferred<void>();
      const gate = deferred<void>();
      const originalAppend = storage.append.bind(storage);
      let attempts = 0;
      const activeDuringAppend: number[] = [];
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) {
          started.resolve();
          await gate.promise;
          activeDuringAppend.push(leases.active.size);
          throw failure;
        }
        activeDuringAppend.push(leases.active.size);
        return originalAppend(...args);
      };

      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      await started.promise;
      expect(leases.active.size).toBe(1);
      gate.resolve();
      expect(await reported.promise).toBe(failure);
      await expect(record.flush()).rejects.toBe(failure);
      expect(leases.active.size).toBe(0);
      expect(leases.leases).toEqual([{ disposeCalls: 1 }]);
      await vi.advanceTimersByTimeAsync(1000);
      await record.flush();

      expect(activeDuringAppend).toEqual([1, 1]);
      expect(leases.leases).toEqual([{ disposeCalls: 1 }, { disposeCalls: 1 }]);
      expect(leases.active.size).toBe(0);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n');
    });

    it('releases each write lease after a partial recovery append fails and reacquires for the next retry', async () => {
      await collect(SCOPE, KEY);
      const leases = trackWriteLeases();
      disposables.add(record.bindWriteGuard(SCOPE, KEY, leases.guard));
      const failure = diskFull();
      const reported = deferred<unknown>();
      const starts = Array.from({ length: 3 }, () => deferred<void>());
      const gates = Array.from({ length: 3 }, () => deferred<void>());
      const originalAppend = storage.append.bind(storage);
      let attempts = 0;
      const activeDuringAppend: number[] = [];
      storage.append = async (scope, key, bytes, options) => {
        const attempt = attempts++;
        starts[attempt]!.resolve();
        await gates[attempt]!.promise;
        activeDuringAppend.push(leases.active.size);
        await originalAppend(scope, key, attempt < 2 ? bytes.subarray(0, 3) : bytes, options);
        if (attempt < 2) throw failure;
      };

      record.append(SCOPE, KEY, { n: 1, text: '中文🙂' }, { onError: reported.resolve });
      await starts[0]!.promise;
      expect(leases.active.size).toBe(1);
      gates[0]!.resolve();
      expect(await reported.promise).toBe(failure);
      expect(leases.active.size).toBe(0);

      const firstRetry = vi.advanceTimersByTimeAsync(1000);
      await starts[1]!.promise;
      expect(leases.active.size).toBe(1);
      gates[1]!.resolve();
      await firstRetry;
      await expect(record.flush()).rejects.toBe(failure);
      expect(leases.active.size).toBe(0);

      const secondRetry = vi.advanceTimersByTimeAsync(2000);
      await starts[2]!.promise;
      expect(leases.active.size).toBe(1);
      gates[2]!.resolve();
      await secondRetry;
      await record.flush();

      expect(activeDuringAppend).toEqual([1, 1, 1]);
      expect(leases.leases).toEqual([
        { disposeCalls: 1 }, { disposeCalls: 1 }, { disposeCalls: 1 },
      ]);
      expect(leases.active.size).toBe(0);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1,"text":"中文🙂"}\n');
    });

    it.each(['close', 'dispose', 'retirement'] as const)(
      '%s keeps the in-flight write lease until storage finishes after its guard is unbound',
      async (operation) => {
        const leases = trackWriteLeases();
        const owner = record.acquire(SCOPE, KEY);
        const binding = record.bindWriteGuard(SCOPE, KEY, leases.guard);
        const started = deferred<void>();
        const gate = deferred<void>();
        const originalAppend = storage.append.bind(storage);
        const activeDuringAppend: number[] = [];
        storage.append = async (...args) => {
          started.resolve();
          await gate.promise;
          activeDuringAppend.push(leases.active.size);
          return originalAppend(...args);
        };

        record.append(SCOPE, KEY, { n: 1 });
        await started.promise;
        expect(leases.active.size).toBe(1);
        let finishing: Promise<void>;
        if (operation === 'close') {
          finishing = record.close();
        } else {
          if (operation === 'dispose') disposables.dispose();
          else owner.dispose();
          finishing = record.drainRetirements();
        }
        let finished = false;
        void finishing.then(() => { finished = true; });
        binding.dispose();
        await settle();
        expect(finished).toBe(false);
        expect(leases.active.size).toBe(1);
        expect(leases.leases).toEqual([{ disposeCalls: 0 }]);
        gate.resolve();
        await finishing;
        owner.dispose();
        await record.drainRetirements();

        expect(activeDuringAppend).toEqual([1]);
        expect(leases.leases).toEqual([{ disposeCalls: 1 }]);
        expect(leases.active.size).toBe(0);
        expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n');
      },
    );

    it('defers partial-append recovery while the session write guard declines', async () => {
      const warn = vi.spyOn(ix.get(ILogService), 'warn');
      await collect(SCOPE, KEY);
      const failure = diskFull();
      const reported = deferred<unknown>();
      const originalAppend = storage.append.bind(storage);
      const recovered = vi.fn();
      record.onDidRecover(recovered);
      let acquired = true;
      const binding = record.bindWriteGuard(SCOPE, KEY, () => acquired);
      let attempts = 0;
      storage.append = async (scope, key, data, options) => {
        attempts++;
        if (attempts === 1) {
          await originalAppend(scope, key, data.subarray(0, 7), options);
          throw failure;
        }
        return originalAppend(scope, key, data, options);
      };

      record.append(SCOPE, KEY, { n: 1, text: '中文' }, { onError: reported.resolve });
      record.append(SCOPE, KEY, { n: 2 });
      expect(await reported.promise).toBe(failure);
      acquired = false;
      await vi.advanceTimersByTimeAsync(1000);

      expect(attempts).toBe(1);
      expect(recovered).not.toHaveBeenCalled();
      await expect(record.flush()).rejects.toBe(failure);

      acquired = true;
      await vi.advanceTimersByTimeAsync(2000);
      await record.flush();
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(
        '{"n":1,"text":"中文"}\n{"n":2}\n',
      );
      expect(recovered).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
      binding.dispose();
    });

    it('keeps recovery scheduled when its write guard declines during reconciliation', async () => {
      const warn = vi.spyOn(ix.get(ILogService), 'warn');
      await collect(SCOPE, KEY);
      const failure = diskFull();
      const reported = deferred<unknown>();
      const originalAppend = storage.append.bind(storage);
      const originalSize = storage.size.bind(storage);
      let acquired = true;
      record.bindWriteGuard(SCOPE, KEY, () => acquired);
      let attempts = 0;
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let sizeCalls = 0;
      storage.size = async (...args) => {
        sizeCalls++;
        if (sizeCalls === 2) acquired = false;
        return originalSize(...args);
      };
      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      expect(await reported.promise).toBe(failure);

      await vi.advanceTimersByTimeAsync(1000);
      expect(attempts).toBe(1);
      acquired = true;
      await vi.advanceTimersByTimeAsync(2000);

      expect(attempts).toBe(2);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n');
      expect(warn).not.toHaveBeenCalled();
    });

    it('recognizes repeated partial suffix failures without trusting uncommitted bytes', async () => {
      await collect(SCOPE, KEY);
      const failure = diskFull();
      const reported = deferred<unknown>();
      const originalAppend = storage.append.bind(storage);
      let attempts = 0;
      storage.append = async (scope, key, data, options) => {
        attempts++;
        if (attempts <= 2) {
          await originalAppend(scope, key, data.subarray(0, attempts === 1 ? 16 : 2), options);
          throw failure;
        }
        return originalAppend(scope, key, data, options);
      };
      record.append(SCOPE, KEY, { n: 1, text: '中文' }, { onError: reported.resolve });
      record.append(SCOPE, KEY, { n: 2 });
      expect(await reported.promise).toBe(failure);
      expect.soft(await storage.size(SCOPE, KEY)).toBe(16);
      expect.soft(record.externallyModified(SCOPE, KEY)).toBe(false);

      await vi.advanceTimersByTimeAsync(1000);
      expect.soft(await storage.size(SCOPE, KEY)).toBe(18);
      expect.soft(record.externallyModified(SCOPE, KEY)).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      await record.flush();

      expect(attempts).toBe(3);
      expect(record.externallyModified(SCOPE, KEY)).toBe(false);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(
        '{"n":1,"text":"中文"}\n{"n":2}\n',
      );
    });

    it('recognizes its own partial append before, during and after suffix recovery', async () => {
      await collect(SCOPE, KEY);
      const failure = diskFull();
      const reported = deferred<unknown>();
      const recoveryStarted = deferred<void>();
      const recoveryGate = deferred<void>();
      const originalAppend = storage.append.bind(storage);
      let attempts = 0;
      storage.append = async (scope, key, data, options) => {
        attempts++;
        if (attempts === 1) {
          await originalAppend(scope, key, data.subarray(0, 7), options);
          throw failure;
        }
        await originalAppend(scope, key, data, options);
        recoveryStarted.resolve();
        await recoveryGate.promise;
      };

      record.append(SCOPE, KEY, { n: 1, text: '中文' }, { onError: reported.resolve });
      expect(await reported.promise).toBe(failure);
      expect.soft(record.externallyModified(SCOPE, KEY)).toBe(false);

      const advancing = vi.advanceTimersByTimeAsync(1000);
      await recoveryStarted.promise;
      try {
        expect.soft(record.externallyModified(SCOPE, KEY)).toBe(false);
      } finally {
        recoveryGate.resolve();
      }
      await advancing;
      await record.flush();
      expect.soft(record.externallyModified(SCOPE, KEY)).toBe(false);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(
        '{"n":1,"text":"中文"}\n',
      );

      await originalAppend(SCOPE, KEY, enc.encode('{"n":2}\n'));
      expect(record.externallyModified(SCOPE, KEY)).toBe(true);
    });

    it('does not adopt unread external bytes while completing partial-append recovery', async () => {
      await collect(SCOPE, KEY);
      const failure = diskFull();
      const reported = deferred<unknown>();
      const originalAppend = storage.append.bind(storage);
      await originalAppend(SCOPE, KEY, enc.encode('{"n":0}\n'));
      expect(record.externallyModified(SCOPE, KEY)).toBe(true);
      let attempts = 0;
      storage.append = async (scope, key, data, options) => {
        attempts++;
        if (attempts === 1) {
          await originalAppend(scope, key, data.subarray(0, 16), options);
          throw failure;
        }
        return originalAppend(scope, key, data, options);
      };
      record.append(SCOPE, KEY, { n: 1, text: '中文' }, { onError: reported.resolve });
      record.append(SCOPE, KEY, { n: 2 });
      expect(await reported.promise).toBe(failure);
      expect.soft(record.externallyModified(SCOPE, KEY)).toBe(true);

      await vi.advanceTimersByTimeAsync(1000);
      await record.flush();

      expect(record.externallyModified(SCOPE, KEY)).toBe(true);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(
        '{"n":0}\n{"n":1,"text":"中文"}\n{"n":2}\n',
      );
      await collect(SCOPE, KEY);
      expect(record.externallyModified(SCOPE, KEY)).toBe(false);
    });

    it('detects external growth while a partial append is waiting for recovery', async () => {
      await collect(SCOPE, KEY);
      const failure = diskFull();
      const reported = deferred<unknown>();
      const originalAppend = storage.append.bind(storage);
      storage.append = async (scope, key, data, options) => {
        await originalAppend(scope, key, data.subarray(0, 7), options);
        throw failure;
      };
      record.append(SCOPE, KEY, { n: 1, text: 'buffered event waiting for disk recovery' }, {
        onError: reported.resolve,
      });
      expect(await reported.promise).toBe(failure);
      expect.soft(record.externallyModified(SCOPE, KEY)).toBe(false);

      await originalAppend(SCOPE, KEY, enc.encode('{"n":2}\n'));

      expect(record.externallyModified(SCOPE, KEY)).toBe(true);
    });

    it.each(['close', 'dispose'] as const)(
      '%s settles pending writes when the session write guard keeps declining',
      async (operation) => {
        const sentinel = new Error('write guard was polled repeatedly during shutdown');
        let guardCalls = 0;
        const binding = record.bindWriteGuard(SCOPE, KEY, () => {
          guardCalls++;
          return guardCalls > 20;
        });
        const appended = vi.spyOn(storage, 'append').mockRejectedValue(sentinel);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        record.append(SCOPE, KEY, { n: 1 });
        await record.flush();

        if (operation === 'close') {
          await expect(record.close()).resolves.toBeUndefined();
        } else {
          disposables.dispose();
          await record.drainRetirements();
        }

        expect(guardCalls).toBeLessThan(10);
        expect(appended).not.toHaveBeenCalled();
        expect(await storage.read(SCOPE, KEY)).toBeUndefined();
        const callsAtSettlement = guardCalls;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(guardCalls).toBe(callsAtSettlement);
        binding.dispose();
        warn.mockRestore();
      },
    );

    it('retains the session write guard while its owner retires and unbinds', async () => {
      const owner = record.acquire(SCOPE, KEY);
      const binding = record.bindWriteGuard(SCOPE, KEY, () => false);
      const appended = vi.spyOn(storage, 'append');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      record.append(SCOPE, KEY, { n: 1 });
      await record.flush();

      owner.dispose();
      binding.dispose();
      await record.drainRetirements();

      expect(appended).not.toHaveBeenCalled();
      expect(await storage.read(SCOPE, KEY)).toBeUndefined();
      warn.mockRestore();
    });

    it('retries a disk-full append after a backoff and persists buffered records exactly once', async () => {
      const failure = diskFull();
      let attempts = 0;
      const appended: Uint8Array[] = [];
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        appended.push(args[2].slice());
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let failures = 0;
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });
      const recovered = watchRecovery();

      record.append<Rec>(SCOPE, KEY, { n: 1 }, {
        onError: () => {
          failures++;
          reportFailure();
        },
      });
      await reportedFailure;

      await expect(record.flush()).rejects.toBe(failure);
      expect(attempts).toBe(1);

      record.append<Rec>(SCOPE, KEY, { n: 2 });
      await settle();
      expect(failures).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      await recovered;
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(appended).toEqual([
        enc.encode('{"n":1}\n'),
        enc.encode('{"n":1}\n'),
        enc.encode('{"n":2}\n'),
      ]);
      expect(failures).toBe(1);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n{"n":2}\n');
    });

    it('repairs a torn tail from a partially committed batch before retrying', async () => {
      const failure = diskFull();
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (scope, key, data, options) => {
        attempts++;
        if (attempts === 1) {
          await originalAppend(scope, key, data.subarray(0, 9), options);
          throw failure;
        }
        return originalAppend(scope, key, data, options);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });
      const recovered = watchRecovery();

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      record.append<Rec>(SCOPE, KEY, { n: 2 });
      await reportedFailure;

      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n{');

      await vi.advanceTimersByTimeAsync(1000);
      await recovered;
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n{"n":2}\n');
      expect(attempts).toBe(2);
    });

    it('drops an ambiguously committed batch instead of duplicating it', async () => {
      const failure = diskFull();
      let attempts = 0;
      const appends: { data: Uint8Array; durable?: boolean }[] = [];
      const originalAppend = storage.append.bind(storage);
      storage.append = async (scope, key, data, options) => {
        attempts++;
        appends.push({ data: data.slice(), durable: options?.durable });
        if (attempts === 1) {
          await originalAppend(scope, key, data, options);
          throw failure;
        }
        return originalAppend(scope, key, data, options);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });
      const recovered = watchRecovery();

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      record.append<Rec>(SCOPE, KEY, { n: 2 });
      await reportedFailure;

      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n{"n":2}\n');

      await vi.advanceTimersByTimeAsync(1000);
      await recovered;
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(attempts).toBe(2);
      expect(appends.at(-1)).toEqual({ data: new Uint8Array(), durable: true });
    });

    it.each(['retirement', 'close'] as const)(
      '%s recovers an append that fails after shutdown starts',
      async (shutdown) => {
        const failure = diskFull();
        const started = deferred<void>();
        const gate = deferred<void>();
        const reported = deferred<unknown>();
        let attempts = 0;
        const originalAppend = storage.append.bind(storage);
        storage.append = async (...args) => {
          attempts++;
          if (attempts === 1) {
            started.resolve();
            await gate.promise;
            throw failure;
          }
          return originalAppend(...args);
        };

        const owner = record.acquire(SCOPE, KEY);
        record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
        record.append(SCOPE, KEY, { n: 2 });
        await started.promise;
        let finishing: Promise<unknown>;
        if (shutdown === 'close') {
          finishing = record.close().then(() => undefined, (error: unknown) => error);
        } else {
          owner.dispose();
          finishing = record.drainRetirements();
        }
        gate.resolve();
        expect(await reported.promise).toBe(failure);
        expect(await finishing).toBeUndefined();

        expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
        expect(attempts).toBe(2);
        owner.dispose();
        await record.drainRetirements();
      },
    );

    it.each(['retirement', 'close'] as const)(
      '%s recovers records accepted before the first flush microtask starts',
      async (shutdown) => {
        const failure = diskFull();
        const originalAppend = storage.append.bind(storage);
        let attempts = 0;
        storage.append = async (...args) => {
          attempts++;
          if (attempts === 1) throw failure;
          return originalAppend(...args);
        };
        const owner = record.acquire(SCOPE, KEY);
        record.append(SCOPE, KEY, { n: 1 });
        record.append(SCOPE, KEY, { n: 2 });
        if (shutdown === 'close') {
          await record.close();
        } else {
          owner.dispose();
          await record.drainRetirements();
        }

        expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
        expect(attempts).toBe(2);
        owner.dispose();
        await record.drainRetirements();
      },
    );

    it('close waits for a key first appended while another key is recovering', async () => {
      const failure = diskFull();
      const reported = deferred<unknown>();
      const recoveryStarted = deferred<void>();
      const recoveryGate = deferred<void>();
      const otherStarted = deferred<void>();
      const otherGate = deferred<void>();
      const otherKey = 'other.jsonl';
      const originalAppend = storage.append.bind(storage);
      let attempts = 0;
      storage.append = async (scope, key, data, options) => {
        if (key === KEY) {
          attempts++;
          if (attempts === 1) throw failure;
          recoveryStarted.resolve();
          await recoveryGate.promise;
        } else if (key === otherKey) {
          otherStarted.resolve();
          await otherGate.promise;
        }
        return originalAppend(scope, key, data, options);
      };

      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      expect(await reported.promise).toBe(failure);
      let closed = false;
      const closing = record.close().then(() => {
        closed = true;
      });
      await recoveryStarted.promise;
      record.append(SCOPE, otherKey, { n: 2 });
      await otherStarted.promise;
      recoveryGate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      try {
        expect(closed).toBe(false);
        expect(await storage.size(SCOPE, otherKey)).toBeUndefined();
      } finally {
        otherGate.resolve();
        await closing;
      }

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);
      expect(await collect<Rec>(SCOPE, otherKey)).toEqual([{ n: 2 }]);
    });

    it.each(['same key', 'new keys'] as const)(
      'close waits for successive writes accepted by write listeners on %s',
      async (keys) => {
        const secondStarted = deferred<void>();
        const secondGate = deferred<void>();
        const lastStarted = deferred<void>();
        const lastGate = deferred<void>();
        const originalAppend = storage.append.bind(storage);
        let attempts = 0;
        storage.append = async (...args) => {
          attempts++;
          if (attempts === 2) {
            secondStarted.resolve();
            await secondGate.promise;
          }
          if (attempts === 4) {
            lastStarted.resolve();
            await lastGate.promise;
          }
          return originalAppend(...args);
        };
        let writes = 0;
        disposables.add(record.onDidWrite(() => {
          writes++;
          if (writes < 4) {
            record.append(SCOPE, keys === 'same key' ? KEY : `${writes}.jsonl`, { n: writes + 1 });
          }
        }));
        record.append(SCOPE, KEY, { n: 1 });
        let closed = false;
        const closing = record.close().then(() => { closed = true; });
        await secondStarted.promise;
        secondGate.resolve();
        await lastStarted.promise;
        await settle();
        try {
          expect(closed).toBe(false);
        } finally {
          lastGate.resolve();
          await closing;
        }
        const expected = keys === 'same key' ? [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }] : [{ n: 1 }];
        expect(await collect<Rec>(SCOPE, KEY)).toEqual(expected);
        if (keys === 'new keys') {
          for (let n = 2; n <= 4; n++) {
            expect(await collect<Rec>(SCOPE, `${n - 1}.jsonl`)).toEqual([{ n }]);
          }
        }
        await vi.advanceTimersByTimeAsync(60_000);
        expect(attempts).toBe(4);
      },
    );

    it.each([
      ['close', 'queued'],
      ['close', 'running'],
      ['dispose', 'queued'],
      ['dispose', 'running'],
    ] as const)('%s leaves no writes or directory recreation after a %s recovery fails', async (shutdown, phase) => {
      const root = await mkdtemp(join(tmpdir(), 'append-log-shutdown-'));
      const dataDir = join(root, 'data');
      const files = new FileStorageService(dataDir);
      const logs = new AppendLogStore(files, stubLog(), new InMemorySessionLockService());
      const failure = diskFull();
      const reported = deferred<unknown>();
      const started = deferred<void>();
      const gate = deferred<void>();
      const originalAppend = files.append.bind(files);
      const sizes = vi.spyOn(files, 'size');
      let diskAvailable = false;
      let attempts = 0;
      files.append = async (scope, key, bytes, options) => {
        attempts++;
        if (diskAvailable) return originalAppend(scope, key, bytes, options);
        if (attempts === 1) await originalAppend(scope, key, bytes.subarray(0, 9), options);
        if (attempts === 2 && phase === 'running') {
          started.resolve();
          await gate.promise;
        }
        throw failure;
      };
      try {
        logs.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
        logs.append(SCOPE, KEY, { n: 2 });
        expect(await reported.promise).toBe(failure);
        if (phase === 'running') {
          await vi.advanceTimersByTimeAsync(1_000);
          await started.promise;
        }
        let finished = false;
        let finishing: Promise<unknown>;
        if (shutdown === 'close') {
          finishing = logs.close().then(() => undefined, (error: unknown) => error);
        } else {
          void logs.dispose();
          finishing = logs.drainRetirements();
        }
        const closing = finishing.then((result) => { finished = true; return result; });
        if (phase === 'running') {
          await settle();
          expect(finished).toBe(false);
        }
        gate.resolve();
        expect(await closing).toBe(shutdown === 'close' ? failure : undefined);
        const attemptsAtShutdown = attempts;
        const sizesAtShutdown = sizes.mock.calls.length;
        expect(attemptsAtShutdown).toBe(phase === 'running' ? 3 : 2);
        await rm(dataDir, { recursive: true, force: true });
        diskAvailable = true;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sizes).toHaveBeenCalledTimes(sizesAtShutdown);
        expect(attempts).toBe(attemptsAtShutdown);
        await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
        if (shutdown === 'close') {
          await logs.close();
          expect(new TextDecoder().decode(await files.read(SCOPE, KEY))).toBe('{"n":1}\n{"n":2}\n');
        }
      } finally {
        gate.resolve();
        void logs.dispose();
        await logs.drainRetirements();
        await rm(root, { recursive: true, force: true });
      }
    });

    it('dispose drains records accepted before the flush microtask and rejects later mutations', async () => {
      const logs = new AppendLogStore(storage, stubLog(), new InMemorySessionLockService());
      const append = vi.spyOn(storage, 'append');
      const owner = logs.acquire(SCOPE, KEY);
      logs.append(SCOPE, KEY, { n: 1 });
      logs.append(SCOPE, KEY, { n: 2 });
      void logs.dispose();
      owner.dispose();
      await logs.drainRetirements();
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n{"n":2}\n');
      expect(() => logs.append(SCOPE, KEY, { n: 3 })).toThrow('disposed');
      expect(() => logs.acquire(SCOPE, KEY)).toThrow('disposed');
      await expect(logs.rewrite(SCOPE, KEY, [{ n: 9 }])).rejects.toThrow('disposed');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(append).toHaveBeenCalledTimes(1);
    });

    it('dispose and final owner release do not retry an already settled failed close', async () => {
      const logs = new AppendLogStore(storage, stubLog(), new InMemorySessionLockService());
      const failure = diskFull();
      const append = vi.spyOn(storage, 'append').mockRejectedValue(failure);
      const owner = logs.acquire(SCOPE, KEY);
      logs.append(SCOPE, KEY, { n: 1 });
      await expect(logs.close()).rejects.toBe(failure);
      expect(append).toHaveBeenCalledTimes(2);
      owner.dispose();
      void logs.dispose();
      await logs.drainRetirements();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(append).toHaveBeenCalledTimes(2);
    });

    it.each(['dispose', 'retirement'] as const)(
      '%s joins a second explicit close before its recovery append starts',
      async (shutdown) => {
        const logs = new AppendLogStore(storage, stubLog(), new InMemorySessionLockService());
        const failure = diskFull();
        const started = deferred<void>();
        const gate = deferred<void>();
        const originalAppend = storage.append.bind(storage);
        let attempts = 0;
        storage.append = async (...args) => {
          attempts++;
          if (attempts <= 2) throw failure;
          started.resolve();
          await gate.promise;
          return originalAppend(...args);
        };
        const owner = logs.acquire(SCOPE, KEY);
        logs.append(SCOPE, KEY, { n: 1 });
        await expect(logs.close()).rejects.toBe(failure);
        const retry = logs.close();
        if (shutdown === 'dispose') void logs.dispose();
        else owner.dispose();
        let drained = false;
        const draining = logs.drainRetirements().then(() => { drained = true; });
        await started.promise;
        await settle();
        try {
          expect(drained).toBe(false);
        } finally {
          gate.resolve();
          await Promise.all([retry, draining]);
          owner.dispose();
          void logs.dispose();
          await logs.drainRetirements();
        }
        expect(attempts).toBe(3);
        expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(attempts).toBe(3);
      },
    );

    it.each([
      ['retirement', false],
      ['retirement', true],
      ['dispose', false],
      ['dispose', true],
    ] as const)('%s reports a queued append failure once when recovery succeeds: %s', async (shutdown, recovers) => {
      const logs = new AppendLogStore(storage, stubLog(), new InMemorySessionLockService());
      const failure = diskFull();
      const originalAppend = storage.append.bind(storage);
      let attempts = 0;
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1 || !recovers) throw failure;
        return originalAppend(...args);
      };
      const owner = logs.acquire(SCOPE, KEY);
      const onError = vi.fn();
      logs.append(SCOPE, KEY, { n: 1 }, { onError });
      if (shutdown === 'retirement') owner.dispose();
      else void logs.dispose();
      await logs.drainRetirements();
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(attempts).toBe(2);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(recovers ? '{"n":1}\n' : '');
      owner.dispose();
      void logs.dispose();
      await logs.drainRetirements();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(2);
    });

    it.each([0, 3, 8])('does not recreate a missing committed prefix after a failed append of %i bytes', async (committed) => {
      await storage.append(SCOPE, KEY, enc.encode('{"n":0}\n'));
      const failure = diskFull();
      const reported = deferred<unknown>();
      const originalAppend = storage.append.bind(storage);
      let attempts = 0;
      storage.append = async (scope, key, bytes, options) => {
        attempts++;
        if (attempts === 1) {
          await originalAppend(scope, key, bytes.subarray(0, committed), options);
          throw failure;
        }
        return originalAppend(scope, key, bytes, options);
      };
      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      expect(await reported.promise).toBe(failure);
      await storage.delete(SCOPE, KEY);
      await expect(record.close()).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
      expect(attempts).toBe(1);
      expect(await storage.size(SCOPE, KEY)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(1);
    });

    it.each(['zero', 'partial', 'full'] as const)(
      'retries the original encoded bytes after a mutable record changes during a %s append failure',
      async (committed) => {
        await storage.append(SCOPE, KEY, enc.encode('{"n":0}\n'));
        await collect(SCOPE, KEY);
        const failure = diskFull();
        const reported = deferred<unknown>();
        const appendStarted = deferred<void>();
        const gate = deferred<void>();
        const originalAppend = storage.append.bind(storage);
        const value = { n: 1, text: 'original 中文🙂' };
        const encoded = enc.encode(JSON.stringify(value) + '\n');
        const cut = committed === 'zero' ? 0 : committed === 'full' ? encoded.byteLength : 15;
        const appends: { data: Uint8Array; durable?: boolean }[] = [];
        storage.append = async (scope, key, bytes, options) => {
          appends.push({ data: bytes.slice(), durable: options?.durable });
          if (appends.length === 1) {
            appendStarted.resolve();
            await gate.promise;
            await originalAppend(scope, key, bytes.subarray(0, cut), options);
            throw failure;
          }
          await originalAppend(scope, key, bytes, options);
          if (appends.length === 2) throw failure;
        };
        const recovered = vi.fn();
        disposables.add(record.onDidRecover(recovered));

        record.append(SCOPE, KEY, value, { onError: reported.resolve });
        await appendStarted.promise;
        value.n = 99;
        value.text = 'mutated value';
        record.append(SCOPE, KEY, { n: 2 });
        gate.resolve();
        expect(await reported.promise).toBe(failure);
        await vi.advanceTimersByTimeAsync(1000);
        expect(recovered).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
        await record.flush();

        expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(
          '{"n":0}\n{"n":1,"text":"original 中文🙂"}\n{"n":2}\n',
        );
        expect(appends).toEqual([
          { data: encoded, durable: true },
          { data: encoded.subarray(cut), durable: true },
          { data: new Uint8Array(), durable: true },
          { data: enc.encode('{"n":2}\n'), durable: true },
        ]);
        expect(recovered).toHaveBeenCalledExactlyOnceWith({ scope: SCOPE, key: KEY });
        expect(record.externallyModified(SCOPE, KEY)).toBe(false);
      },
    );

    it.each([
      { serialization: 'toJSON', committed: 'zero' },
      { serialization: 'toJSON', committed: 'partial' },
      { serialization: 'toJSON', committed: 'full' },
      { serialization: 'getter', committed: 'zero' },
      { serialization: 'getter', committed: 'partial' },
      { serialization: 'getter', committed: 'full' },
    ])(
      'does not re-encode a stateful $serialization after a $committed append failure',
      async ({ serialization, committed }) => {
        const failure = diskFull();
        const reported = deferred<unknown>();
        const originalAppend = storage.append.bind(storage);
        let serializations = 0;
        const value = serialization === 'toJSON'
          ? { toJSON: () => ({ n: 1, text: `encoding-${++serializations}-中文🙂` }) }
          : { n: 1, get text() { return `encoding-${++serializations}-中文🙂`; } };
        const encoded = enc.encode('{"n":1,"text":"encoding-1-中文🙂"}\n');
        const cut = committed === 'zero' ? 0 : committed === 'full' ? encoded.byteLength : 15;
        const appends: { data: Uint8Array; durable?: boolean }[] = [];
        storage.append = async (scope, key, bytes, options) => {
          appends.push({ data: bytes.slice(), durable: options?.durable });
          await originalAppend(scope, key, appends.length === 1 ? bytes.subarray(0, cut) : bytes, options);
          if (appends.length <= 2) throw failure;
        };
        const recovered = vi.fn();
        disposables.add(record.onDidRecover(recovered));

        record.append(SCOPE, KEY, value, { onError: reported.resolve });
        expect(await reported.promise).toBe(failure);
        record.append(SCOPE, KEY, { n: 2 });
        await vi.advanceTimersByTimeAsync(1000);
        expect(recovered).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
        await record.flush();

        expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(
          '{"n":1,"text":"encoding-1-中文🙂"}\n{"n":2}\n',
        );
        expect(serializations).toBe(1);
        expect(appends).toEqual([
          { data: encoded, durable: true },
          { data: encoded.subarray(cut), durable: true },
          { data: new Uint8Array(), durable: true },
          { data: enc.encode('{"n":2}\n'), durable: true },
        ]);
        expect(recovered).toHaveBeenCalledExactlyOnceWith({ scope: SCOPE, key: KEY });
      },
    );

    it('completes a partial append using only its missing suffix', async () => {
      const seed = enc.encode('{"n":0}\n');
      await storage.append(SCOPE, KEY, seed);
      const failure = diskFull();
      const reported = deferred<unknown>();
      const originalRead = storage.read.bind(storage);
      const reads = vi.spyOn(storage, 'read');
      const writes = vi.spyOn(storage, 'write');
      const originalAppend = storage.append.bind(storage);
      const appended: Uint8Array[] = [];
      storage.append = async (scope, key, data, options) => {
        appended.push(data.slice());
        if (appended.length === 1) {
          await originalAppend(scope, key, data.subarray(0, 9), options);
          throw failure;
        }
        return originalAppend(scope, key, data, options);
      };

      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      record.append(SCOPE, KEY, { n: 2 });
      expect(await reported.promise).toBe(failure);
      await vi.advanceTimersByTimeAsync(1000);
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
      expect(new TextDecoder().decode(await originalRead(SCOPE, KEY))).toBe(
        '{"n":0}\n{"n":1}\n{"n":2}\n',
      );
      expect(reads).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(appended).toEqual([
        enc.encode('{"n":1}\n{"n":2}\n'),
        enc.encode('{"n":1}\n{"n":2}\n').subarray(9),
      ]);
    });

    it('retains the original recovery boundary across repeated partial UTF-8 writes', async () => {
      const seed = enc.encode('{"n":0}\n');
      await storage.append(SCOPE, KEY, seed);
      const records = [{ n: 1, text: '中文🙂' }, { n: 2, text: '界' }];
      const batch = enc.encode(records.map((entry) => JSON.stringify(entry) + '\n').join(''));
      const firstCut = enc.encode('{"n":1,"text":"').byteLength + 1;
      const secondCut = 4;
      const failure = diskFull();
      const reported = deferred<unknown>();
      const originalRead = storage.read.bind(storage);
      const reads = vi.spyOn(storage, 'read');
      const writes = vi.spyOn(storage, 'write');
      const originalAppend = storage.append.bind(storage);
      const appended: Uint8Array[] = [];
      storage.append = async (scope, key, data, options) => {
        appended.push(data.slice());
        if (appended.length <= 2) {
          const cut = appended.length === 1 ? firstCut : secondCut;
          await originalAppend(scope, key, data.subarray(0, cut), options);
          throw failure;
        }
        return originalAppend(scope, key, data, options);
      };

      for (const entry of records) {
        record.append(SCOPE, KEY, entry, { onError: reported.resolve });
      }
      expect(await reported.promise).toBe(failure);
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      expect(await originalRead(SCOPE, KEY)).toEqual(
        new Uint8Array([...seed, ...batch.subarray(0, firstCut + secondCut)]),
      );
      await vi.advanceTimersByTimeAsync(2000);
      await record.flush();

      expect(await collect(SCOPE, KEY)).toEqual([{ n: 0 }, ...records]);
      expect(appended).toEqual([
        batch,
        batch.subarray(firstCut),
        batch.subarray(firstCut + secondCut),
      ]);
      expect(reads).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    });

    it('retries durability after a fully committed batch until the empty append succeeds', async () => {
      const failure = diskFull();
      const reported = deferred<unknown>();
      const originalAppend = storage.append.bind(storage);
      const appends: { data: Uint8Array; durable?: boolean }[] = [];
      storage.append = async (scope, key, data, options) => {
        appends.push({ data: data.slice(), durable: options?.durable });
        if (appends.length === 1) {
          await originalAppend(scope, key, data, options);
          throw failure;
        }
        if (appends.length === 2) throw failure;
        return originalAppend(scope, key, data, options);
      };
      let recoveries = 0;
      disposables.add(record.onDidRecover(() => {
        recoveries++;
      }));

      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      record.append(SCOPE, KEY, { n: 2 });
      expect(await reported.promise).toBe(failure);
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      expect(recoveries).toBe(0);
      await expect(record.flush()).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(2000);
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(recoveries).toBe(1);
      expect(appends).toEqual([
        { data: enc.encode('{"n":1}\n{"n":2}\n'), durable: true },
        { data: new Uint8Array(), durable: true },
        { data: new Uint8Array(), durable: true },
      ]);
    });

    it.each([
      { phase: 'tail read', retire: false, recoveryFails: false },
      { phase: 'tail read', retire: true, recoveryFails: false },
      { phase: 'suffix append', retire: false, recoveryFails: false },
      { phase: 'suffix append', retire: true, recoveryFails: false },
      { phase: 'suffix append', retire: false, recoveryFails: true },
      { phase: 'suffix append', retire: true, recoveryFails: true },
    ])(
      'rewrite during $phase preserves accepted records with retirement=$retire and recovery failure=$recoveryFails',
      async ({ phase, retire, recoveryFails }) => {
        await storage.append(SCOPE, KEY, enc.encode('{"n":0}\n'));
        const failure = diskFull();
        const reported = deferred<unknown>();
        const recoveryStarted = deferred<void>();
        const gate = deferred<void>();
        const originalAppend = storage.append.bind(storage);
        let attempts = 0;
        storage.append = async (scope, key, data, options) => {
          attempts++;
          if (attempts === 1) {
            const length = phase === 'tail read' ? data.byteLength : 9;
            await originalAppend(scope, key, data.subarray(0, length), options);
            throw failure;
          }
          if (attempts === 2 && phase === 'suffix append') {
            recoveryStarted.resolve();
            await gate.promise;
            if (recoveryFails) {
              await originalAppend(scope, key, data.subarray(0, 2), options);
              throw failure;
            }
          }
          return originalAppend(scope, key, data, options);
        };
        const originalReadStream = storage.readStream.bind(storage);
        let readBlocked = false;
        storage.readStream = async function* (scope, key, range) {
          if (phase === 'tail read' && range !== undefined && !readBlocked) {
            readBlocked = true;
            recoveryStarted.resolve();
            await gate.promise;
          }
          yield* originalReadStream(scope, key, range);
        };

        const owner = record.acquire(SCOPE, KEY);
        record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
        record.append(SCOPE, KEY, { n: 2 });
        expect(await reported.promise).toBe(failure);
        await vi.advanceTimersByTimeAsync(1000);
        await recoveryStarted.promise;

        const rewriting = record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
        record.append(SCOPE, KEY, { n: 3 });
        if (retire) owner.dispose();
        gate.resolve();
        await rewriting;
        if (retire) await record.drainRetirements();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(await collect<Rec>(SCOPE, KEY)).toEqual([
          { n: 9 }, { n: 1 }, { n: 2 }, { n: 3 },
        ]);
        expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(
          '{"n":9}\n{"n":1}\n{"n":2}\n{"n":3}\n',
        );
        owner.dispose();
        await record.drainRetirements();
      },
    );

    it.each(['resolve', 'reject'] as const)(
      'rewrite invalidates a pending failed-recovery end observation that will %s',
      async (outcome) => {
        await storage.append(SCOPE, KEY, enc.encode('{"n":0}\n'));
        await collect(SCOPE, KEY);
        const leases = trackWriteLeases();
        disposables.add(record.bindWriteGuard(SCOPE, KEY, leases.guard));
        const failure = diskFull();
        const reported = deferred<unknown>();
        const observing = deferred<void>();
        const gate = deferred<void>();
        const recovered = vi.fn();
        disposables.add(record.onDidRecover(recovered));
        const originalAppend = storage.append.bind(storage);
        const originalSize = storage.size.bind(storage);
        const originalSizeSync = storage.sizeSync.bind(storage);
        let attempts = 0;
        let failSyncObservation = false;
        let failedSyncObservations = 0;
        const append = vi.spyOn(storage, 'append').mockImplementation(async (scope, key, data, options) => {
          attempts++;
          if (attempts <= 2) {
            await originalAppend(scope, key, data.subarray(0, attempts === 1 ? 9 : 2), options);
            if (attempts === 2) failSyncObservation = true;
            throw failure;
          }
          return originalAppend(scope, key, data, options);
        });
        storage.sizeSync = (...args) => {
          if (failSyncObservation) {
            failSyncObservation = false;
            failedSyncObservations++;
            throw new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'sync end observation unavailable');
          }
          return originalSizeSync(...args);
        };
        let observationBlocked = false;
        storage.size = async (...args) => {
          if (attempts === 2 && !observationBlocked) {
            observationBlocked = true;
            observing.resolve();
            await gate.promise;
            if (outcome === 'reject') {
              throw new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'failed end observation');
            }
          }
          return originalSize(...args);
        };
        const write = vi.spyOn(storage, 'write');
        record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
        record.append(SCOPE, KEY, { n: 2 });
        expect(await reported.promise).toBe(failure);
        const recovering = vi.advanceTimersByTimeAsync(1000);
        await observing.promise;
        expect(failedSyncObservations).toBe(1);

        let rewritten = false;
        const rewriting = record.rewrite(SCOPE, KEY, [{ n: 9 }]).then(() => { rewritten = true; });
        record.append(SCOPE, KEY, { n: 3 });
        let closed = false;
        const closing = record.close().then(() => { closed = true; });
        await settle();
        expect(rewritten).toBe(false);
        expect(closed).toBe(false);
        expect(leases.active.size).toBe(1);
        gate.resolve();
        await Promise.all([recovering, rewriting, closing]);

        expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 1 }, { n: 2 }, { n: 3 }]);
        expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(
          '{"n":9}\n{"n":1}\n{"n":2}\n{"n":3}\n',
        );
        expect(recovered).not.toHaveBeenCalled();
        expect(leases.active.size).toBe(0);
        const appendsAtClose = append.mock.calls.length;
        const writesAtClose = write.mock.calls.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(append).toHaveBeenCalledTimes(appendsAtClose);
        expect(write).toHaveBeenCalledTimes(writesAtClose);
        expect(recovered).not.toHaveBeenCalled();
      },
    );

    it.each(['tail read', 'suffix append', 'partial suffix failure'] as const)(
      'close and retirement wait for a running recovery during %s',
      async (phase) => {
        const failure = diskFull();
        const reported = deferred<unknown>();
        const recoveryStarted = deferred<void>();
        const gate = deferred<void>();
        let attempts = 0;
        const originalAppend = storage.append.bind(storage);
        storage.append = async (scope, key, data, options) => {
          attempts++;
          if (attempts === 1) {
            const length = phase === 'tail read' ? data.byteLength : 9;
            await originalAppend(scope, key, data.subarray(0, length), options);
            throw failure;
          }
          if (attempts === 2 && phase !== 'tail read') {
            recoveryStarted.resolve();
            await gate.promise;
            if (phase === 'partial suffix failure') {
              await originalAppend(scope, key, data.subarray(0, 2), options);
              throw failure;
            }
          }
          return originalAppend(scope, key, data, options);
        };
        const originalReadStream = storage.readStream.bind(storage);
        let blocked = false;
        storage.readStream = async function* (scope, key, range) {
          if (phase === 'tail read' && range !== undefined && !blocked) {
            blocked = true;
            recoveryStarted.resolve();
            await gate.promise;
          }
          yield* originalReadStream(scope, key, range);
        };

        const owner = record.acquire(SCOPE, KEY);
        record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
        record.append(SCOPE, KEY, { n: 2 });
        expect(await reported.promise).toBe(failure);
        await vi.advanceTimersByTimeAsync(1000);
        await recoveryStarted.promise;
        const closing = record.close();
        owner.dispose();
        let drained = false;
        const retiring = record.drainRetirements().then(() => {
          drained = true;
        });
        await settle();
        expect(drained).toBe(false);
        gate.resolve();
        await Promise.all([closing, retiring]);

        expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
        expect(attempts).toBe(phase === 'partial suffix failure' ? 3 : 2);
      },
    );

    it.each(['retirement', 'close'] as const)(
      '%s makes only one final attempt when the disk remains full',
      async (shutdown) => {
        const failure = diskFull();
        const started = deferred<void>();
        const gate = deferred<void>();
        const reported = deferred<unknown>();
        let attempts = 0;
        storage.append = async () => {
          attempts++;
          if (attempts === 1) {
            started.resolve();
            await gate.promise;
          }
          throw failure;
        };
        const owner = record.acquire(SCOPE, KEY);
        record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
        await started.promise;
        let finishing: Promise<unknown>;
        if (shutdown === 'close') {
          finishing = record.close().then(() => undefined, (error: unknown) => error);
        } else {
          owner.dispose();
          finishing = record.drainRetirements();
        }
        gate.resolve();
        expect(await reported.promise).toBe(failure);
        expect(await finishing).toBe(shutdown === 'close' ? failure : undefined);
        expect(attempts).toBe(2);
        expect(await storage.size(SCOPE, KEY)).toBeUndefined();
        owner.dispose();
        await record.drainRetirements();
      },
    );

    it('stays sticky when the torn tail does not match the failed batch', async () => {
      const failure = diskFull();
      await storage.append(SCOPE, KEY, enc.encode('{"n":0}\n{"n":99'));
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      await reportedFailure;

      await vi.advanceTimersByTimeAsync(5000);
      await settle();
      expect(attempts).toBe(1);
      await expect(record.flush()).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      await expect(collect<Rec>(SCOPE, KEY)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });

      await record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 1 }]);
    });

    it('re-enters backoff with a growing delay when the recovery attempt itself hits disk-full', async () => {
      const warn = vi.spyOn(ix.get(ILogService), 'warn');
      const failure = diskFull();
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts <= 2) throw failure;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });
      const recovered = watchRecovery();

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      await reportedFailure;

      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      expect(attempts).toBe(2);

      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      expect(attempts).toBe(2);

      await vi.advanceTimersByTimeAsync(1000);
      await recovered;
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);
      expect(attempts).toBe(3);
      expect(warn).not.toHaveBeenCalled();
    });

    it('close() makes a final recovery attempt and persists buffered records', async () => {
      const failure = diskFull();
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      record.append<Rec>(SCOPE, KEY, { n: 2 });
      await reportedFailure;

      await record.close();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(attempts).toBe(2);
    });

    it('does not enter recovery for non-retryable storage errors', async () => {
      const failure = new StorageError(
        StorageErrors.codes.STORAGE_PERMISSION_DENIED,
        'storage append failed: permission denied',
      );
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      await reportedFailure;

      await vi.advanceTimersByTimeAsync(5000);
      await settle();
      expect(attempts).toBe(1);
      await expect(record.flush()).rejects.toBe(failure);
    });

    it('also recovers transient io failures, not only disk-full', async () => {
      const failure = new StorageError(
        StorageErrors.codes.STORAGE_IO_FAILED,
        'storage append failed: unrecognized I/O error',
      );
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });
      const recovered = watchRecovery();

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      await reportedFailure;

      await vi.advanceTimersByTimeAsync(1000);
      await recovered;
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);
      expect(attempts).toBe(2);
    });

    it('retirement performs a final recovery attempt before dropping the log', async () => {
      const failure = diskFull();
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });

      const owner = record.acquire(SCOPE, KEY);
      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      await reportedFailure;

      owner.dispose();
      await record.drainRetirements();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }]);
      expect(attempts).toBe(2);
    });

    it('rewrite cancels a pending recovery and keeps the buffered records', async () => {
      const failure = diskFull();
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      await reportedFailure;
      expect(attempts).toBe(1);

      await record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 1 }]);

      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(attempts).toBe(2);
    });

    it('keeps a failed rewrite sticky until the caller explicitly retries it', async () => {
      const failure = diskFull();
      record.append<Rec>(SCOPE, KEY, { n: 1 });
      await record.flush();

      let writeAttempts = 0;
      const originalWrite = storage.write.bind(storage);
      storage.write = async (...args) => {
        writeAttempts++;
        if (writeAttempts === 1) throw failure;
        return originalWrite(...args);
      };
      const recovered = vi.fn();
      disposables.add(record.onDidRecover(recovered));

      await expect(record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }])).rejects.toBe(failure);
      await expect(record.flush()).rejects.toBe(failure);

      await vi.advanceTimersByTimeAsync(60_000);
      record.append<Rec>(SCOPE, KEY, { n: 2 });
      await expect(record.close()).rejects.toBe(failure);
      expect(recovered).not.toHaveBeenCalled();
      expect(writeAttempts).toBe(1);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":1}\n');

      await record.rewrite<Rec>(SCOPE, KEY, [{ n: 9 }]);
      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 2 }]);
    });

    it.each([
      { committed: 0, appendInFlight: false },
      { committed: 9, appendInFlight: false },
      { committed: 0, appendInFlight: true },
      { committed: 9, appendInFlight: true },
    ])(
      'failed rewrite stays sticky after $committed bytes committed with append in flight=$appendInFlight',
      async ({ committed, appendInFlight }) => {
        await storage.append(SCOPE, KEY, enc.encode('{"n":1}\n'));
        const failure = diskFull();
        const reported = deferred<unknown>();
        const started = deferred<void>();
        const gate = deferred<void>();
        const originalAppend = storage.append.bind(storage);
        let appendAttempts = 0;
        storage.append = async (scope, key, data, options) => {
          appendAttempts++;
          if (appendAttempts === 1) {
            started.resolve();
            await gate.promise;
            await originalAppend(scope, key, data.subarray(0, committed), options);
            throw failure;
          }
          return originalAppend(scope, key, data, options);
        };
        const originalWrite = storage.write.bind(storage);
        let writeAttempts = 0;
        storage.write = async (...args) => {
          writeAttempts++;
          if (writeAttempts === 1) throw failure;
          return originalWrite(...args);
        };
        const recovered = vi.fn();
        disposables.add(record.onDidRecover(recovered));

        record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
        record.append(SCOPE, KEY, { n: 2 });
        await started.promise;
        const rewriting = appendInFlight
          ? expect(record.rewrite(SCOPE, KEY, [{ n: 9 }])).rejects.toBe(failure)
          : undefined;
        gate.resolve();
        expect(await reported.promise).toBe(failure);
        if (rewriting === undefined) {
          await expect(record.rewrite(SCOPE, KEY, [{ n: 9 }])).rejects.toBe(failure);
        } else {
          await rewriting;
        }
        await vi.advanceTimersByTimeAsync(60_000);
        await expect(record.close()).rejects.toBe(failure);
        expect(recovered).not.toHaveBeenCalled();
        expect(appendAttempts).toBe(1);

        await record.rewrite(SCOPE, KEY, [{ n: 9 }]);
        expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 9 }, { n: 1 }, { n: 2 }]);
        expect(appendAttempts).toBe(2);
      },
    );

    it('retries transient boundary-stat failures before attempting any append', async () => {
      const failure = new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'transient stat failure');
      const originalSize = storage.size.bind(storage);
      let sizeAttempts = 0;
      storage.size = async (...args) => {
        sizeAttempts++;
        if (sizeAttempts <= 2) throw failure;
        return originalSize(...args);
      };
      const appended = vi.spyOn(storage, 'append');
      const reported = deferred<unknown>();
      const recovered = vi.fn();
      disposables.add(record.onDidRecover(recovered));

      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      record.append(SCOPE, KEY, { n: 2 });
      expect(await reported.promise).toBe(failure);
      expect(appended).not.toHaveBeenCalled();
      await expect(record.flush()).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sizeAttempts).toBe(2);
      expect(appended).not.toHaveBeenCalled();
      expect(recovered).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(appended).toHaveBeenCalledTimes(1);
      expect(recovered).toHaveBeenCalledTimes(1);
    });

    it('rejects guarded boundary-stat recovery after another session owner grows the log', async () => {
      await storage.append(SCOPE, KEY, enc.encode('{"n":0}\n'));
      await collect(SCOPE, KEY);
      const failure = new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'transient stat failure');
      const originalSize = storage.size.bind(storage);
      const originalAppend = storage.append.bind(storage);
      let acquired = true;
      disposables.add(record.bindWriteGuard(SCOPE, KEY, () => acquired));
      const size = vi.spyOn(storage, 'size').mockImplementationOnce(async () => {
        throw failure;
      }).mockImplementation(originalSize);
      const appended = vi.spyOn(storage, 'append');
      const recovered = vi.fn();
      disposables.add(record.onDidRecover(recovered));
      const reported = deferred<unknown>();

      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      expect(await reported.promise).toBe(failure);
      acquired = false;
      await originalAppend(SCOPE, KEY, enc.encode('{"n":2}\n'));
      await vi.advanceTimersByTimeAsync(1000);
      acquired = true;
      await vi.advanceTimersByTimeAsync(2000);

      await expect.soft(record.flush()).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
      expect.soft(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":0}\n{"n":2}\n');
      expect.soft(appended).not.toHaveBeenCalled();
      expect.soft(recovered).not.toHaveBeenCalled();
      const calls = size.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(size).toHaveBeenCalledTimes(calls);
    });

    it.each([
      { phase: 'before append', changed: false },
      { phase: 'before append', changed: true },
      { phase: 'fully committed append', changed: false },
      { phase: 'fully committed append', changed: true },
    ])('validates the guarded prefix after $phase fails with same-length modification=$changed', async ({ phase, changed }) => {
      const warn = vi.spyOn(ix.get(ILogService), 'warn');
      const seed = enc.encode('{"n":0}\n');
      await storage.append(SCOPE, KEY, seed);
      await collect(SCOPE, KEY);
      const leases = trackWriteLeases();
      disposables.add(record.bindWriteGuard(SCOPE, KEY, leases.guard));
      const failure = phase === 'before append'
        ? new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'transient stat failure')
        : diskFull();
      const originalSize = storage.size.bind(storage);
      const originalAppend = storage.append.bind(storage);
      const originalWrite = storage.write.bind(storage);
      const originalReadStream = storage.readStream.bind(storage);
      const activeDuringReads: number[] = [];
      storage.readStream = async function* (...args) {
        activeDuringReads.push(leases.active.size);
        yield* originalReadStream(...args);
      };
      if (phase === 'before append') {
        vi.spyOn(storage, 'size').mockImplementationOnce(async () => {
          throw failure;
        }).mockImplementation(originalSize);
      }
      const appended: Uint8Array[] = [];
      storage.append = async (...args) => {
        appended.push(args[2].slice());
        await originalAppend(...args);
        if (phase === 'fully committed append' && appended.length === 1) throw failure;
      };
      const recovered = vi.fn();
      disposables.add(record.onDidRecover(recovered));
      const reported = deferred<unknown>();
      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      expect(await reported.promise).toBe(failure);
      expect.soft(activeDuringReads).toEqual([1]);
      const before = await storage.read(SCOPE, KEY);
      const foreign = enc.encode(phase === 'before append' ? '{"n":8}\n' : '{"n":8}\n{"n":1}\n');
      expect(foreign.byteLength).toBe(before!.byteLength);
      if (changed) await originalWrite(SCOPE, KEY, foreign);
      const attemptsBefore = appended.length;
      await vi.advanceTimersByTimeAsync(1000);

      if (changed) {
        await expect.soft(record.flush()).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
        expect.soft(appended).toHaveLength(attemptsBefore);
        expect.soft(recovered).not.toHaveBeenCalled();
        expect.soft(await storage.read(SCOPE, KEY)).toEqual(foreign);
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          'automatic append-log recovery stopped; buffered records remain in memory',
          {
            scope: SCOPE,
            key: KEY,
            pending: 1,
            error: expect.objectContaining({ message: 'append-log recovery aborted: original prefix was modified' }),
          },
        );
      } else {
        await record.flush();
        expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":0}\n{"n":1}\n');
        expect(appended).toEqual(phase === 'before append'
          ? [enc.encode('{"n":1}\n')]
          : [enc.encode('{"n":1}\n'), new Uint8Array()]);
        expect(recovered).toHaveBeenCalledExactlyOnceWith({ scope: SCOPE, key: KEY });
        expect(warn).not.toHaveBeenCalled();
      }
      expect(leases.active.size).toBe(0);
      expect(leases.leases).toEqual([{ disposeCalls: 1 }, { disposeCalls: 1 }]);
      expect(activeDuringReads.every((active) => active === 1)).toBe(true);
    });

    it.each(['prefix read', 'end observation'] as const)(
      'reports stopped recovery once when the original %s is unavailable without external writes',
      async (phase) => {
        const seed = enc.encode('{"n":0}\n');
        await storage.append(SCOPE, KEY, seed);
        await collect(SCOPE, KEY);
        disposables.add(record.bindWriteGuard(SCOPE, KEY, () => true));
        const failure = diskFull();
        const unavailable = new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'temporary evidence read failure');
        const originalAppend = storage.append.bind(storage);
        const originalSize = storage.size.bind(storage);
        const originalSizeSync = storage.sizeSync.bind(storage);
        const originalReadStream = storage.readStream.bind(storage);
        let evidenceUnavailable = false;
        let appendFailed = false;
        storage.append = async (...args) => {
          if (!appendFailed) {
            appendFailed = true;
            evidenceUnavailable = true;
            throw failure;
          }
          return originalAppend(...args);
        };
        storage.size = async (...args) => {
          if (phase === 'end observation' && evidenceUnavailable) throw unavailable;
          return originalSize(...args);
        };
        storage.sizeSync = (...args) => {
          if (phase === 'end observation' && evidenceUnavailable) throw unavailable;
          return originalSizeSync(...args);
        };
        storage.readStream = async function* (...args) {
          if (phase === 'prefix read' && evidenceUnavailable) throw unavailable;
          yield* originalReadStream(...args);
        };
        const warn = vi.spyOn(ix.get(ILogService), 'warn');
        const reported = deferred<unknown>();
        const onError = vi.fn(reported.resolve);
        record.append(SCOPE, KEY, { n: 1 }, { onError });
        record.append(SCOPE, KEY, { n: 2 });
        expect(await reported.promise).toBe(failure);
        expect(warn).not.toHaveBeenCalled();
        evidenceUnavailable = false;

        await vi.advanceTimersByTimeAsync(60_000);

        await expect(record.flush()).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          'automatic append-log recovery stopped; buffered records remain in memory',
          {
            scope: SCOPE,
            key: KEY,
            pending: 2,
            error: expect.objectContaining({
              message: 'append-log recovery aborted: trusted failure-time prefix or end evidence is unavailable',
            }),
          },
        );
        expect(await storage.read(SCOPE, KEY)).toEqual(seed);
        await expect(record.close()).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
        await expect(record.close()).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
        disposables.dispose();
        await record.drainRetirements();
        expect(warn).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
      },
    );

    it.each(['before append', 'fully committed append'] as const)(
      'does not replace a failed guarded prefix capture with a fresh baseline after %s fails',
      async (phase) => {
        await storage.append(SCOPE, KEY, enc.encode('{"n":0}\n'));
        await collect(SCOPE, KEY);
        const leases = trackWriteLeases();
        disposables.add(record.bindWriteGuard(SCOPE, KEY, leases.guard));
        const failure = phase === 'before append'
          ? new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'transient stat failure')
          : diskFull();
        const captureFailure = new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'transient read failure');
        const originalSize = storage.size.bind(storage);
        const originalAppend = storage.append.bind(storage);
        const originalWrite = storage.write.bind(storage);
        const originalReadStream = storage.readStream.bind(storage);
        let readAttempts = 0;
        const activeDuringReads: number[] = [];
        storage.readStream = async function* (...args) {
          readAttempts++;
          activeDuringReads.push(leases.active.size);
          if (readAttempts === 1) throw captureFailure;
          yield* originalReadStream(...args);
        };
        if (phase === 'before append') {
          vi.spyOn(storage, 'size').mockImplementationOnce(async () => {
            throw failure;
          }).mockImplementation(originalSize);
        }
        const appended: Uint8Array[] = [];
        storage.append = async (...args) => {
          appended.push(args[2].slice());
          await originalAppend(...args);
          if (phase === 'fully committed append' && appended.length === 1) throw failure;
        };
        const recovered = vi.fn();
        disposables.add(record.onDidRecover(recovered));
        const reported = deferred<unknown>();
        record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
        expect(await reported.promise).toBe(failure);
        expect.soft(activeDuringReads).toEqual([1]);
        const foreign = enc.encode(phase === 'before append' ? '{"n":8}\n' : '{"n":8}\n{"n":1}\n');
        await originalWrite(SCOPE, KEY, foreign);
        const attemptsBefore = appended.length;
        await vi.advanceTimersByTimeAsync(1000);

        await expect.soft(record.flush()).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
        expect.soft(appended).toHaveLength(attemptsBefore);
        expect.soft(recovered).not.toHaveBeenCalled();
        expect.soft(await storage.read(SCOPE, KEY)).toEqual(foreign);
        expect(leases.active.size).toBe(0);
        expect(leases.leases).toEqual([{ disposeCalls: 1 }, { disposeCalls: 1 }]);
      },
    );

    it('recovers a guarded boundary-stat failure using the established read baseline when sizeSync fails', async () => {
      await storage.append(SCOPE, KEY, enc.encode('{"n":0}\n'));
      await collect(SCOPE, KEY);
      const failure = new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'transient stat failure');
      const originalSize = storage.size.bind(storage);
      disposables.add(record.bindWriteGuard(SCOPE, KEY, () => true));
      const sizeSync = vi.spyOn(storage, 'sizeSync').mockImplementation(() => {
        throw failure;
      });
      vi.spyOn(storage, 'size').mockImplementationOnce(async () => {
        throw failure;
      }).mockImplementation(originalSize);
      const appended = vi.spyOn(storage, 'append');
      const recovered = vi.fn();
      disposables.add(record.onDidRecover(recovered));
      const reported = deferred<unknown>();

      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      record.append(SCOPE, KEY, { n: 2 });
      expect(await reported.promise).toBe(failure);
      await vi.advanceTimersByTimeAsync(1000);
      await record.flush();

      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(
        '{"n":0}\n{"n":1}\n{"n":2}\n',
      );
      expect(appended).toHaveBeenCalledOnce();
      expect(recovered).toHaveBeenCalledExactlyOnceWith({ scope: SCOPE, key: KEY });
      sizeSync.mockRestore();
      expect(record.externallyModified(SCOPE, KEY)).toBe(false);
    });

    it('keeps the guarded recovery baseline after repairing a partial append while sizeSync fails', async () => {
      await storage.append(SCOPE, KEY, enc.encode('{"n":0}\n'));
      await collect(SCOPE, KEY);
      const failure = diskFull();
      const originalAppend = storage.append.bind(storage);
      let acquired = true;
      disposables.add(record.bindWriteGuard(SCOPE, KEY, () => acquired));
      const sizeSync = vi.spyOn(storage, 'sizeSync').mockImplementation(() => {
        throw failure;
      });
      let attempts = 0;
      storage.append = async (scope, key, bytes, options) => {
        attempts++;
        if (attempts === 1) {
          await originalAppend(scope, key, bytes.subarray(0, 3), options);
          throw failure;
        }
        await originalAppend(scope, key, bytes, options);
        if (attempts === 2) acquired = false;
      };
      const recovered = vi.fn();
      disposables.add(record.onDidRecover(recovered));
      const reported = deferred<unknown>();

      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      expect(await reported.promise).toBe(failure);
      record.append(SCOPE, KEY, { n: 2 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":0}\n{"n":1}\n');
      expect(recovered).not.toHaveBeenCalled();
      acquired = true;
      await vi.advanceTimersByTimeAsync(1000);
      await record.flush();

      expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":0}\n{"n":1}\n{"n":2}\n');
      expect(attempts).toBe(3);
      expect(recovered).toHaveBeenCalledExactlyOnceWith({ scope: SCOPE, key: KEY });
      sizeSync.mockRestore();
      expect(record.externallyModified(SCOPE, KEY)).toBe(false);
    });

    it('does not blindly append during guarded boundary-stat recovery without a known baseline', async () => {
      await storage.append(SCOPE, KEY, enc.encode('{"n":0}\n'));
      const failure = new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'transient stat failure');
      const originalSize = storage.size.bind(storage);
      disposables.add(record.bindWriteGuard(SCOPE, KEY, () => true));
      vi.spyOn(storage, 'size').mockImplementationOnce(async () => {
        throw failure;
      }).mockImplementation(originalSize);
      const appended = vi.spyOn(storage, 'append');
      const recovered = vi.fn();
      disposables.add(record.onDidRecover(recovered));
      const reported = deferred<unknown>();

      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      expect(await reported.promise).toBe(failure);
      await vi.advanceTimersByTimeAsync(1000);

      await expect.soft(record.flush()).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
      expect.soft(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe('{"n":0}\n');
      expect.soft(appended).not.toHaveBeenCalled();
      expect.soft(recovered).not.toHaveBeenCalled();
    });

    it('recovers an unguarded shared session index boundary-stat failure after external growth', async () => {
      const scope = '';
      const key = 'session_index.jsonl';
      await storage.append(scope, key, enc.encode('{"n":0}\n'));
      await collect(scope, key);
      const failure = new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'transient stat failure');
      const originalSize = storage.size.bind(storage);
      const originalAppend = storage.append.bind(storage);
      vi.spyOn(storage, 'size').mockImplementationOnce(async () => {
        throw failure;
      }).mockImplementation(originalSize);
      const appended = vi.spyOn(storage, 'append');
      const recovered = vi.fn();
      disposables.add(record.onDidRecover(recovered));
      const reported = deferred<unknown>();

      record.append(scope, key, { n: 1 }, { onError: reported.resolve });
      expect(await reported.promise).toBe(failure);
      await originalAppend(scope, key, enc.encode('{"n":2}\n'));
      await vi.advanceTimersByTimeAsync(1000);
      await record.flush();

      expect(new TextDecoder().decode(await storage.read(scope, key))).toBe('{"n":0}\n{"n":2}\n{"n":1}\n');
      expect(appended).toHaveBeenCalledOnce();
      expect(recovered).toHaveBeenCalledExactlyOnceWith({ scope, key });
    });

    it.each(['different size', 'stat failure'] as const)(
      'rewrite supersedes guarded boundary-stat recovery awaiting a %s',
      async (result) => {
        const warn = vi.spyOn(ix.get(ILogService), 'warn');
        await storage.append(SCOPE, KEY, enc.encode('{"n":0}\n'));
        await collect(SCOPE, KEY);
        disposables.add(record.bindWriteGuard(SCOPE, KEY, () => true));
        const failure = new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'transient stat failure');
        const originalSize = storage.size.bind(storage);
        const recoveryStarted = deferred<void>();
        const gate = deferred<void>();
        let sizeCalls = 0;
        storage.size = async (...args) => {
          sizeCalls++;
          if (sizeCalls === 1) throw failure;
          if (sizeCalls === 2) {
            recoveryStarted.resolve();
            await gate.promise;
            if (result === 'stat failure') throw failure;
            return 16;
          }
          return originalSize(...args);
        };
        const recovered = vi.fn();
        disposables.add(record.onDidRecover(recovered));
        const reported = deferred<unknown>();
        record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
        expect(await reported.promise).toBe(failure);
        const advancing = vi.advanceTimersByTimeAsync(1000);
        await recoveryStarted.promise;

        const rewriting = record.rewrite(SCOPE, KEY, [{ n: 9 }]);
        record.append(SCOPE, KEY, { n: 2 });
        gate.resolve();
        await Promise.all([advancing, rewriting]);
        record.append(SCOPE, KEY, { n: 3 });
        await record.flush();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(new TextDecoder().decode(await storage.read(SCOPE, KEY))).toBe(
          '{"n":9}\n{"n":1}\n{"n":2}\n{"n":3}\n',
        );
        expect(record.externallyModified(SCOPE, KEY)).toBe(false);
        expect(recovered).not.toHaveBeenCalled();
        expect(warn.mock.calls.filter(([message]) => message.startsWith('automatic append-log recovery stopped'))).toEqual([]);
      },
    );

    it('becomes sticky when a recovery attempt hits a non-retryable error', async () => {
      const warn = vi.spyOn(ix.get(ILogService), 'warn');
      const permanent = new StorageError(
        StorageErrors.codes.STORAGE_PERMISSION_DENIED,
        'storage append failed: permission denied',
      );
      const failure = diskFull();
      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        if (attempts === 2) throw permanent;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      await reportedFailure;

      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();

      expect(attempts).toBe(2);
      await expect(record.flush()).rejects.toBe(permanent);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'automatic append-log recovery stopped; buffered records remain in memory',
        { scope: SCOPE, key: KEY, pending: 1, error: permanent },
      );
    });

    it.each([
      { phase: 'zero-byte initial failure', cuts: [0] },
      { phase: 'one committed event from the initial batch', cuts: [8] },
      { phase: 'a second partial append during recovery', cuts: [1, 7] },
    ])('rejects matching foreign bytes appended after $phase', async ({ cuts }) => {
      const seed = enc.encode('{"n":0}\n');
      const batch = enc.encode('{"n":1}\n{"n":2}\n');
      await storage.append(SCOPE, KEY, seed);
      await collect(SCOPE, KEY);
      const leases = trackWriteLeases();
      disposables.add(record.bindWriteGuard(SCOPE, KEY, leases.guard));
      const failure = diskFull();
      const reported = deferred<unknown>();
      const recovered = vi.fn();
      disposables.add(record.onDidRecover(recovered));
      const originalAppend = storage.append.bind(storage);
      const appended: Uint8Array[] = [];
      storage.append = async (scope, key, data, options) => {
        appended.push(data.slice());
        const cut = cuts[appended.length - 1];
        if (cut !== undefined) {
          await originalAppend(scope, key, data.subarray(0, cut), options);
          throw failure;
        }
        return originalAppend(scope, key, data, options);
      };
      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      record.append(SCOPE, KEY, { n: 2 });
      expect(await reported.promise).toBe(failure);
      if (cuts.length > 1) await vi.advanceTimersByTimeAsync(1000);
      await expect(record.flush()).rejects.toBe(failure);
      expect(leases.active.size).toBe(0);
      const committed = cuts.reduce((sum, cut) => sum + cut, 0);
      expect(await storage.read(SCOPE, KEY)).toEqual(new Uint8Array([...seed, ...batch.subarray(0, committed)]));
      await originalAppend(SCOPE, KEY, batch.subarray(committed));
      const foreign = await storage.read(SCOPE, KEY);
      const attempts = appended.length;

      await vi.advanceTimersByTimeAsync(60_000);

      await expect.soft(record.flush()).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
      expect.soft(recovered).not.toHaveBeenCalled();
      expect.soft(appended).toHaveLength(attempts);
      expect.soft(await storage.read(SCOPE, KEY)).toEqual(foreign);
      expect.soft(record.externallyModified(SCOPE, KEY)).toBe(true);
      expect(leases.active.size).toBe(0);
    });

    it('rejects a guarded failed append whose observed tail was truncated', async () => {
      const seed = enc.encode('{"n":0}\n');
      const batch = enc.encode('{"n":1}\n{"n":2}\n');
      await storage.append(SCOPE, KEY, seed);
      await collect(SCOPE, KEY);
      const leases = trackWriteLeases();
      disposables.add(record.bindWriteGuard(SCOPE, KEY, leases.guard));
      const failure = diskFull();
      const reported = deferred<unknown>();
      const recovered = vi.fn();
      disposables.add(record.onDidRecover(recovered));
      const originalAppend = storage.append.bind(storage);
      const append = vi.spyOn(storage, 'append').mockImplementationOnce(async (scope, key, data, options) => {
        await originalAppend(scope, key, data.subarray(0, 8), options);
        throw failure;
      }).mockImplementation(originalAppend);
      record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
      record.append(SCOPE, KEY, { n: 2 });
      expect(await reported.promise).toBe(failure);
      expect(leases.active.size).toBe(0);
      const truncated = new Uint8Array([...seed, ...batch.subarray(0, 7)]);
      await storage.write(SCOPE, KEY, truncated);

      await vi.advanceTimersByTimeAsync(1000);

      await expect.soft(record.flush()).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
      expect.soft(recovered).not.toHaveBeenCalled();
      expect.soft(append).toHaveBeenCalledTimes(1);
      expect.soft(await storage.read(SCOPE, KEY)).toEqual(truncated);
      expect(leases.active.size).toBe(0);
    });

    it.each(['initial append', 'recovery append'] as const)(
      'does not reuse or recapture the guarded end after its %s observation fails',
      async (phase) => {
        const seed = enc.encode('{"n":0}\n');
        const batch = enc.encode('{"n":1}\n{"n":2}\n');
        await storage.append(SCOPE, KEY, seed);
        await collect(SCOPE, KEY);
        const leases = trackWriteLeases();
        disposables.add(record.bindWriteGuard(SCOPE, KEY, leases.guard));
        const failure = diskFull();
        const observationFailure = new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'failed append end is unreadable');
        const reported = deferred<unknown>();
        const recovered = vi.fn();
        disposables.add(record.onDidRecover(recovered));
        const originalAppend = storage.append.bind(storage);
        const originalSize = storage.size.bind(storage);
        const originalSizeSync = storage.sizeSync.bind(storage);
        let observationUnavailable = false;
        let failedObservations = 0;
        storage.size = async (...args) => {
          if (observationUnavailable && leases.active.size > 0) {
            failedObservations++;
            throw observationFailure;
          }
          return originalSize(...args);
        };
        storage.sizeSync = (...args) => {
          if (observationUnavailable && leases.active.size > 0) {
            failedObservations++;
            throw observationFailure;
          }
          return originalSizeSync(...args);
        };
        let attempts = 0;
        storage.append = async (scope, key, data, options) => {
          attempts++;
          if (attempts === 1 || (phase === 'recovery append' && attempts === 2)) {
            await originalAppend(scope, key, data.subarray(0, attempts === 1 ? 3 : 2), options);
            observationUnavailable = phase === 'initial append' || attempts === 2;
            throw failure;
          }
          return originalAppend(scope, key, data, options);
        };
        record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
        record.append(SCOPE, KEY, { n: 2 });
        expect(await reported.promise).toBe(failure);
        if (phase === 'recovery append') await vi.advanceTimersByTimeAsync(1000);
        expect(failedObservations).toBeGreaterThan(0);
        expect(leases.active.size).toBe(0);
        observationUnavailable = false;
        const foreign = new Uint8Array([...seed, ...batch.subarray(0, 3)]);
        await storage.write(SCOPE, KEY, foreign);
        const attemptsBefore = attempts;

        await vi.advanceTimersByTimeAsync(60_000);

        await expect.soft(record.flush()).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
        expect.soft(recovered).not.toHaveBeenCalled();
        expect.soft(attempts).toBe(attemptsBefore);
        expect.soft(await storage.read(SCOPE, KEY)).toEqual(foreign);
        expect(leases.active.size).toBe(0);
      },
    );

    it.each(['initial append', 'recovery append'] as const)(
      'keeps a successful synchronous end observation after %s when async stat is unavailable in that lease',
      async (phase) => {
        const seed = enc.encode('{"n":0}\n');
        const batch = enc.encode('{"n":1}\n{"n":2}\n');
        await storage.append(SCOPE, KEY, seed);
        await collect(SCOPE, KEY);
        const leases = trackWriteLeases();
        disposables.add(record.bindWriteGuard(SCOPE, KEY, leases.guard));
        const failure = diskFull();
        const reported = deferred<unknown>();
        const recovered = vi.fn();
        disposables.add(record.onDidRecover(recovered));
        const originalAppend = storage.append.bind(storage);
        const originalSize = storage.size.bind(storage);
        const originalSizeSync = storage.sizeSync.bind(storage);
        let attempts = 0;
        let unavailableLease: number | undefined;
        let successfulSyncObservations = 0;
        let redundantAsyncObservations = 0;
        storage.size = async (...args) => {
          if (leases.active.size > 0 && leases.leases.length === unavailableLease) {
            redundantAsyncObservations++;
            throw new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'async end observation unavailable');
          }
          return originalSize(...args);
        };
        storage.sizeSync = (...args) => {
          if (leases.active.size > 0 && leases.leases.length === unavailableLease) {
            successfulSyncObservations++;
          }
          return originalSizeSync(...args);
        };
        storage.append = async (scope, key, data, options) => {
          attempts++;
          if (attempts === 1 || (phase === 'recovery append' && attempts === 2)) {
            await originalAppend(scope, key, data.subarray(0, attempts === 1 ? 3 : 2), options);
            if (phase === 'initial append' || attempts === 2) unavailableLease = leases.leases.length;
            throw failure;
          }
          return originalAppend(scope, key, data, options);
        };
        record.append(SCOPE, KEY, { n: 1 }, { onError: reported.resolve });
        record.append(SCOPE, KEY, { n: 2 });
        expect(await reported.promise).toBe(failure);
        if (phase === 'recovery append') await vi.advanceTimersByTimeAsync(1000);
        await expect(record.flush()).rejects.toBe(failure);
        expect(successfulSyncObservations).toBe(1);
        expect(redundantAsyncObservations).toBe(0);

        await vi.advanceTimersByTimeAsync(phase === 'recovery append' ? 2000 : 1000);
        await record.flush();

        expect(await storage.read(SCOPE, KEY)).toEqual(new Uint8Array([...seed, ...batch]));
        expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
        expect(recovered).toHaveBeenCalledExactlyOnceWith({ scope: SCOPE, key: KEY });
        expect(redundantAsyncObservations).toBe(0);
        expect(attempts).toBe(phase === 'recovery append' ? 3 : 2);
        expect(leases.active.size).toBe(0);
      },
    );

    it('does not confuse pre-existing identical content with a committed batch', async () => {
      const failure = diskFull();
      record.append<Rec>(SCOPE, KEY, { n: 1 });
      await record.flush();

      let attempts = 0;
      const originalAppend = storage.append.bind(storage);
      storage.append = async (...args) => {
        attempts++;
        if (attempts === 1) throw failure;
        return originalAppend(...args);
      };
      let reportFailure!: () => void;
      const reportedFailure = new Promise<void>((resolve) => {
        reportFailure = resolve;
      });
      const recovered = watchRecovery();

      record.append<Rec>(SCOPE, KEY, { n: 1 }, { onError: reportFailure });
      await reportedFailure;

      await vi.advanceTimersByTimeAsync(1000);
      await recovered;
      await record.flush();

      expect(await collect<Rec>(SCOPE, KEY)).toEqual([{ n: 1 }, { n: 1 }]);
      expect(attempts).toBe(2);
    });
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
    ix.stub(ILogService, stubLog());
    ix.stub(ISessionLockService, new InMemorySessionLockService());
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

  it('rejects an identical foreign batch committed under a new real session lock', async () => {
    const bootstrap = {
      homeDir,
      clientIdentity: { productName: 'test', version: '0.0.0', platform: 'test' },
    } as IBootstrapService;
    const firstLocks = new SessionLockService(bootstrap, stubLog());
    const nextLocks = new SessionLockService(bootstrap, stubLog());
    const nextStorage = new FileStorageService(homeDir);
    const firstLog = new AppendLogStore(storage, stubLog(), firstLocks);
    const nextLog = new AppendLogStore(nextStorage, stubLog(), nextLocks);
    const sessionId = 'example-session';
    const bind = (target: AppendLogStore, locks: SessionLockService) => target.bindWriteGuard(SCOPE, KEY, () => {
      const lease = locks.lease(sessionId);
      return { dispose: () => { lease.release(); } };
    });
    const firstGuard = bind(firstLog, firstLocks);
    const nextGuard = bind(nextLog, nextLocks);
    const failure = new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'injected zero-byte append failure');
    const originalAppend = storage.append.bind(storage);
    const appended = vi.spyOn(storage, 'append').mockRejectedValueOnce(failure).mockImplementation(originalAppend);
    const recovered = vi.fn();
    const subscription = firstLog.onDidRecover(recovered);
    try {
      await originalAppend(SCOPE, KEY, enc.encode('{"n":0}\n'));
      for await (const value of firstLog.read(SCOPE, KEY)) void value;
      firstLog.append(SCOPE, KEY, { n: 1 }, { onError: () => {} });
      await expect(firstLog.flush()).rejects.toBe(failure);
      expect(firstLocks.held(sessionId)).toBe(false);
      nextLog.append(SCOPE, KEY, { n: 1 });
      await nextLog.flush();
      expect(nextLocks.held(sessionId)).toBe(false);
      const foreign = await storage.read(SCOPE, KEY);
      expect(new TextDecoder().decode(foreign)).toBe('{"n":0}\n{"n":1}\n');

      await expect.soft(firstLog.close()).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });

      await expect.soft(firstLog.flush()).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
      expect.soft(recovered).not.toHaveBeenCalled();
      expect.soft(appended).toHaveBeenCalledTimes(1);
      expect.soft(await storage.read(SCOPE, KEY)).toEqual(foreign);
      expect(firstLocks.held(sessionId)).toBe(false);
    } finally {
      await firstLog.dispose();
      await nextLog.dispose();
      firstGuard.dispose();
      nextGuard.dispose();
      subscription.dispose();
      firstLocks.dispose();
      nextLocks.dispose();
      appended.mockRestore();
    }
  });

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
  });

  it('does not adopt unread external bytes when its own healthy append completes', async () => {
    await readAll();
    appendFileSync(join(homeDir, SCOPE, KEY), '{"n":1}\n');
    expect(log.externallyModified(SCOPE, KEY)).toBe(true);

    log.append<Rec>(SCOPE, KEY, { n: 2 });
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
