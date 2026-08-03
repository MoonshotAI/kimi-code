// test/compaction-internal.test.ts
//
// White-box boundary tests for the compaction helpers (copyFileRange /
// fsyncDir) that are hard to reach through the public MiniDb API. Both are
// exported from src/compaction.ts for this purpose but are NOT re-exported
// from the package entry point.
//
// Fault-injection tests (mocked fs) live in compaction-fault.test.ts so that
// their dynamic imports + query-string cache busting do not distort the
// coverage report of this file (Node's coverage keys scripts by URL).

import { expect, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyFileRange, fsyncDir } from '../src/compaction.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-copy-'));
}

// --- copyFileRange: happy path ------------------------------------------------

test('copyFileRange copies an arbitrary byte range verbatim', async () => {
  const dir = await tmpDir();
  try {
    const src = path.join(dir, 'src');
    const dst = path.join(dir, 'dst');
    const data = Buffer.alloc(8192);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 256;
    await fs.writeFile(src, data);

    await copyFileRange(src, dst, 1000, 6000);

    const out = await fs.readFile(dst);
    assert.equal(out.length, 5000);
    assert.ok(out.equals(data.subarray(1000, 6000)));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('copyFileRange copies a range larger than one internal chunk', async () => {
  // COPY_CHUNK is 1 MiB; copy 2.5 MiB to exercise the multi-chunk loop.
  const dir = await tmpDir();
  try {
    const src = path.join(dir, 'src');
    const dst = path.join(dir, 'dst');
    const size = (5 << 20) / 2; // 2.5 MiB
    const data = Buffer.alloc(size);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    await fs.writeFile(src, data);

    await copyFileRange(src, dst, 0, data.length);

    const out = await fs.readFile(dst);
    assert.equal(out.length, data.length);
    assert.ok(out.equals(data));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- copyFileRange: EOF / empty-range boundaries -----------------------------

test('copyFileRange stops at EOF when end exceeds the source size', async () => {
  // Exercises the `bytesRead === 0` break: the source is shorter than the
  // requested range, so read() returns 0 and the loop terminates early.
  const dir = await tmpDir();
  try {
    const src = path.join(dir, 'src');
    const dst = path.join(dir, 'dst');
    await fs.writeFile(src, Buffer.from('hello')); // 5 bytes

    await copyFileRange(src, dst, 0, 1000); // ask for far more than exists

    const out = await fs.readFile(dst);
    assert.ok(out.equals(Buffer.from('hello')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('copyFileRange with start===end creates an empty file in create mode', async () => {
  const dir = await tmpDir();
  try {
    const src = path.join(dir, 'src');
    const dst = path.join(dir, 'dst');
    await fs.writeFile(src, Buffer.from('data'));
    await fs.writeFile(dst, Buffer.from('preexisting-to-be-truncated'));

    await copyFileRange(src, dst, 2, 2); // empty range, 'w' truncates

    const out = await fs.readFile(dst);
    assert.equal(out.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('copyFileRange with start===end in append mode leaves existing content intact', async () => {
  const dir = await tmpDir();
  try {
    const src = path.join(dir, 'src');
    const dst = path.join(dir, 'dst');
    await fs.writeFile(src, Buffer.from('source'));
    await fs.writeFile(dst, Buffer.from('existing'));

    await copyFileRange(src, dst, 3, 3, { append: true });

    const out = await fs.readFile(dst);
    assert.ok(out.equals(Buffer.from('existing'))); // unchanged
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('copyFileRange in append mode appends the range to existing content', async () => {
  const dir = await tmpDir();
  try {
    const src = path.join(dir, 'src');
    const dst = path.join(dir, 'dst');
    await fs.writeFile(src, Buffer.from('0123456789'));
    await fs.writeFile(dst, Buffer.from('abc'));

    await copyFileRange(src, dst, 2, 5, { append: true });

    const out = await fs.readFile(dst);
    assert.ok(out.equals(Buffer.from('abc234')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('copyFileRange rejects end < start', async () => {
  await assert.rejects(() => copyFileRange('/tmp/a', '/tmp/b', 10, 5), /end \(5\) < start \(10\)/);
});

// --- fsyncDir ----------------------------------------------------------------

test('fsyncDir syncs an existing directory without throwing', async () => {
  const dir = await tmpDir();
  try {
    await expect(fsyncDir(dir)).resolves.toBeUndefined();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('fsyncDir swallows errors when the directory cannot be opened', async () => {
  // A non-existent path makes fs.open reject → the catch branch runs and the
  // finally closes nothing (fh is null). Best-effort semantics.
  const bogus = path.join(os.tmpdir(), `minidb-no-such-dir-${Date.now()}`);
  await expect(fsyncDir(bogus)).resolves.toBeUndefined();
});
