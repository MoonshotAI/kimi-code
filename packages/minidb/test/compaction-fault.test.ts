// test/compaction-fault.test.ts
//
// Fault-injection tests for the compaction helpers using `vi.doMock` to replace
// node:fs/promises. These exercise branches that real filesystems essentially
// never produce (a write that returns 0 bytes, a close/sync that throws).
//
// The later sections cover compaction ROTATION failures end-to-end (through a
// real MiniDb on a real temp dir): a throw at wal.close(), at the WAL rename,
// or at the new WAL's open() must not wedge the database — the seal is
// one-way, so recovery swaps in a fresh WAL on db.walPath.
//
// NOTE: each test resets the module registry and re-mocks node:fs/promises so a
// fresh import of compaction.ts picks up that test's mocked fs.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PathLike } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';

interface MockHandle {
  read?: (...args: unknown[]) => Promise<{ bytesRead: number }>;
  write?: (...args: unknown[]) => Promise<{ bytesWritten: number }>;
  sync?: () => Promise<void>;
  close?: () => Promise<void>;
}

// Replace node:fs/promises with a module whose only export is `open`. compaction.ts
// consumes it via a default import (`import fs from 'node:fs/promises'`), so the
// mock also exposes the same handle set as its `default` export.
function mockFsPromises(open: (path: string, flags?: string) => Promise<MockHandle>): void {
  const exports = { open };
  vi.doMock('node:fs/promises', () => ({ ...exports, default: exports }));
}

afterEach(() => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
});

test('copyFileRange throws when the destination short-writes (bytesWritten === 0)', async () => {
  mockFsPromises(async (_p, flags) => {
    if (flags === 'r') {
      // Source claims to have produced bytes so the loop reaches write().
      return { read: async () => ({ bytesRead: 16 }), close: async () => {} };
    }
    // Destination makes no progress → the short-write guard fires.
    return { write: async () => ({ bytesWritten: 0 }), sync: async () => {}, close: async () => {} };
  });
  const { copyFileRange } = await import('../src/compaction.js');
  await assert.rejects(() => copyFileRange('/tmp/src', '/tmp/dst', 0, 16), /short write/);
});

test('copyFileRange tolerates a source close() failure (best-effort close)', async () => {
  mockFsPromises(async (_p, flags) => {
    if (flags === 'r') {
      return {
        read: async (buf: unknown) => {
          (buf as Buffer)[0] = 0xab;
          return { bytesRead: 1 };
        },
        close: async () => {
          throw new Error('source close failed');
        },
      };
    }
    return {
      write: async (_b: unknown, _o: unknown, len: number) => ({ bytesWritten: len }),
      sync: async () => {},
      close: async () => {},
    };
  });
  const { copyFileRange } = await import('../src/compaction.js');
  // The source close failure is swallowed; the copy itself succeeds.
  await expect(copyFileRange('/tmp/src', '/tmp/dst', 0, 1)).resolves.toBeUndefined();
});

test('copyFileRange tolerates a destination close() failure (best-effort close)', async () => {
  mockFsPromises(async (_p, flags) => {
    if (flags === 'r') {
      return { read: async () => ({ bytesRead: 0 }), close: async () => {} };
    }
    return {
      write: async (_b: unknown, _o: unknown, len: number) => ({ bytesWritten: len }),
      sync: async () => {},
      close: async () => {
        throw new Error('dest close failed');
      },
    };
  });
  const { copyFileRange } = await import('../src/compaction.js');
  // Empty range (start===end) → no writes, only a dst.sync() then a failing
  // dst.close() that must be swallowed.
  await expect(copyFileRange('/tmp/src', '/tmp/dst', 0, 0)).resolves.toBeUndefined();
});

test('fsyncDir swallows a sync() failure and still closes the handle', async () => {
  let closed = false;
  mockFsPromises(async () => ({
    sync: async () => {
      throw new Error('sync failed');
    },
    close: async () => {
      closed = true;
    },
  }));
  const { fsyncDir } = await import('../src/compaction.js');
  await fsyncDir('/tmp/whatever');
  assert.equal(closed, true, 'close() is called even after sync() throws');
});


async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-rotation-fault-'));
}

// Passthrough node:fs/promises mock for the rotation-level tests: everything
// delegates to the real module, except operations whose fault callback returns
// an error — that error is thrown instead of delegating. Lets a test fail ONE
// rotation step (a specific rename, one append-handle open) deterministically
// while the rest of MiniDb keeps using the real filesystem.
function mockFsWithFaults(faults: {
  rename?: (src: string, dst: string) => Error | null;
  open?: (path: string, flags: string | number | undefined) => Error | null;
}): void {
  const rename = async (src: PathLike, dst: PathLike): Promise<void> => {
    const err = faults.rename?.(String(src), String(dst));
    if (err) throw err;
    await fs.rename(src, dst);
  };
  const open = (async (p: PathLike, flags?: string | number, mode?: string | number) => {
    const err = faults.open?.(String(p), flags);
    if (err) throw err;
    return fs.open(p, flags as string | number | undefined, mode as never);
  }) as typeof fs.open;
  const mocked = { ...fs, rename, open };
  vi.doMock('node:fs/promises', () => ({ ...mocked, default: mocked }));
}

test('wal.close() propagates a final-sync failure but still releases the file handle', async () => {
  const { WAL } = await import('../src/wal.js');
  const { encodeFrame, FrameParser, TYPE_SET } = await import('../src/codec.js');
  const dir = await tmpDir();
  try {
    const file = path.join(dir, 'db.wal');
    const wal = new WAL(file, { fsyncPolicy: 'no' }); // 'no': no background sync timer
    await wal.open();
    await wal.append(encodeFrame({ type: TYPE_SET, key: Buffer.from('a'), value: Buffer.from('1') }));

    const origSync = wal.sync.bind(wal);
    wal.sync = async () => {
      wal.sync = origSync; // one-shot
      throw new Error('injected fsync failure');
    };
    await assert.rejects(wal.close(), /injected fsync failure/);
    // The failed close still released the handle (compaction's recovery swap
    // abandons this WAL object and must not leak its fd)...
    assert.equal((wal as unknown as { fh: unknown }).fh, null);
    // ...the WAL stays closed...
    await wal.close();
    // ...and the flushed frame stayed durable, so a fresh WAL — which is what
    // rotation recovery swaps in — continues the same file at the real EOF.
    const fresh = new WAL(file, { fsyncPolicy: 'no' });
    await fresh.open();
    assert.ok(fresh.size > 0);
    await fresh.append(encodeFrame({ type: TYPE_SET, key: Buffer.from('b'), value: Buffer.from('2') }));
    await fresh.close();

    const frames = [...new FrameParser().feed(await fs.readFile(file))];
    assert.deepEqual(
      frames.map((f) => f.key.toString()),
      ['a', 'b'],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rotation: a WAL close() failure leaves the db writable and compact() retries cleanly', async () => {
  const { MiniDb } = await import('../src/index.js');
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open<string>({ dir, valueCodec: 'string', fsyncPolicy: 'no', compactThresholdBytes: 1 << 30 });
    const N = 200;
    for (let i = 0; i < N; i++) await db.set(`k${i}`, `v${i}`);

    const wal = db.wal;
    let parked: Promise<void> | undefined;
    const origClose = wal.close.bind(wal);
    wal.close = async () => {
      wal.close = origClose; // one-shot
      // Inside the rotation the old WAL is already sealed and _rotateLock is
      // held: a write issued now parks on the lock and must still succeed once
      // the failed rotation has recovered.
      parked = db.set('parked', 'during-failed-rotation');
      throw new Error('injected close failure');
    };
    await assert.rejects(db.compact(), /injected close failure/);
    assert.equal(db.stats.compactions, 0);
    assert.equal(db.stats.compactErrors, 1);
    assert.match(String(db.lastCompactError), /injected close failure/);

    // The parked write and every later write hit the recovered (swapped-in)
    // WAL, not the sealed/closed old one.
    await parked;
    await db.set('post', 'still-writable');
    assert.equal(db.get('parked'), 'during-failed-rotation');
    assert.equal(db.get('post'), 'still-writable');

    // An explicit compact() retries cleanly after the failed rotation.
    await db.compact();
    assert.equal(db.stats.compactions, 1);
    assert.equal(db.stats.compactErrors, 1);
    assert.equal(db.lastCompactError, null);
    await db.close();

    db = await MiniDb.open<string>({ dir, valueCodec: 'string' });
    assert.equal(db.size, N + 2);
    assert.equal(db.get('k0'), 'v0');
    assert.equal(db.get(`k${N - 1}`), `v${N - 1}`);
    assert.equal(db.get('parked'), 'during-failed-rotation');
    assert.equal(db.get('post'), 'still-writable');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rotation: a WAL rename failure (new snapshot already in place) leaves the db writable', async () => {
  let armed = true;
  mockFsWithFaults({
    rename: (src, dst) => {
      // Fail only the first db.wal.tmp → db.wal rename: by then the new
      // snapshot has already been renamed into place, so this exercises the
      // trickiest partial-rotation state (new snapshot + old full WAL).
      if (armed && src.endsWith('db.wal.tmp') && dst.endsWith('db.wal')) {
        armed = false;
        return Object.assign(new Error('injected rename failure'), { code: 'EIO' });
      }
      return null;
    },
  });
  const { MiniDb } = await import('../src/index.js');
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open<string>({ dir, valueCodec: 'string', fsyncPolicy: 'no', compactThresholdBytes: 1 << 30 });
    const N = 200;
    for (let i = 0; i < N; i++) await db.set(`k${i}`, `v${i}`);

    await assert.rejects(db.compact(), /injected rename failure/);
    assert.equal(db.stats.compactions, 0);
    assert.equal(db.stats.compactErrors, 1);

    await db.set('post', 'still-writable');
    assert.equal(db.get('k0'), 'v0');
    assert.equal(db.get('post'), 'still-writable');

    // An explicit compact() retries cleanly on top of the partial rotation.
    await db.compact();
    assert.equal(db.stats.compactions, 1);
    assert.equal(db.stats.compactErrors, 1);
    assert.equal(db.lastCompactError, null);
    await db.close();

    db = await MiniDb.open<string>({ dir, valueCodec: 'string' });
    assert.equal(db.size, N + 1);
    assert.equal(db.get('k0'), 'v0');
    assert.equal(db.get(`k${N - 1}`), `v${N - 1}`);
    assert.equal(db.get('post'), 'still-writable');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rotation: a new-WAL open() failure after the renames leaves the db writable', async () => {
  let canArm = true;
  let armOpenFault = false;
  mockFsWithFaults({
    rename: (src, dst) => {
      // Arm the open fault once the FIRST WAL rename has landed, so it hits
      // the first append-handle open afterwards — the fresh WAL's open()
      // inside the rotation. Later compactions must re-arm nothing.
      if (canArm && src.endsWith('db.wal.tmp') && dst.endsWith('db.wal')) {
        canArm = false;
        armOpenFault = true;
      }
      return null;
    },
    open: (p, flags) => {
      if (armOpenFault && flags === 'a' && p.endsWith('db.wal')) {
        armOpenFault = false;
        return Object.assign(new Error('injected open failure'), { code: 'EMFILE' });
      }
      return null;
    },
  });
  const { MiniDb } = await import('../src/index.js');
  const dir = await tmpDir();
  try {
    const opts = { dir, valueCodec: 'string' as const, valueMode: 'disk' as const, fsyncPolicy: 'no' as const, compactThresholdBytes: 1 << 30 };
    let db = await MiniDb.open<string>(opts);
    const N = 200;
    for (let i = 0; i < N; i++) await db.set(`k${i}`, `v${i}`);

    await assert.rejects(db.compact(), /injected open failure/);
    assert.equal(db.stats.compactions, 0);
    assert.equal(db.stats.compactErrors, 1);

    // The renames had already committed the new snapshot/WAL layout when the
    // open failed, so recovery also applied the store-pointer remap.
    const sawSnapshotRef = [...db.store.map.values()].some((r) => r.ref.kind === 'disk' && r.ref.loc.file === 'snapshot');
    assert.ok(sawSnapshotRef, 'store pointers were remapped to the new snapshot after the failed rotation');

    // Disk-backed reads stay correct and the db is writable again.
    assert.equal(db.get('k0'), 'v0');
    assert.equal(db.get(`k${N - 1}`), `v${N - 1}`);
    await db.set('post', 'still-writable');
    assert.equal(db.get('post'), 'still-writable');

    await db.compact();
    assert.equal(db.stats.compactions, 1);
    assert.equal(db.get('k42'), 'v42');
    await db.close();

    db = await MiniDb.open<string>(opts);
    assert.equal(db.size, N + 1);
    assert.equal(db.get('k0'), 'v0');
    assert.equal(db.get(`k${N - 1}`), `v${N - 1}`);
    assert.equal(db.get('post'), 'still-writable');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a compaction whose onCompacted hook throws counts as a compactError, not a compaction', async () => {
  const { MiniDb } = await import('../src/index.js');
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open<string>({ dir, valueCodec: 'string', fsyncPolicy: 'no', compactThresholdBytes: 1 << 30 });
    for (let i = 0; i < 50; i++) await db.set(`k${i}`, `v${i}`);

    const hook = db.onCompacted;
    let failHook = true;
    db.onCompacted = () => {
      if (failHook) throw new Error('injected hook failure');
      hook();
    };
    await assert.rejects(db.compact(), /injected hook failure/);
    // The hook is part of the compaction: compactions counts only fully
    // successful runs, even though the rotation itself had already succeeded.
    assert.equal(db.stats.compactions, 0);
    assert.equal(db.stats.compactErrors, 1);
    assert.match(String(db.lastCompactError), /injected hook failure/);

    // The rotation succeeded, so the db keeps working normally.
    await db.set('post', 'ok');
    assert.equal(db.size, 51);

    failHook = false;
    await db.compact();
    assert.equal(db.stats.compactions, 1);
    assert.equal(db.stats.compactErrors, 1);
    assert.equal(db.lastCompactError, null);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
