// test/wal.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WAL } from '../src/wal.js';
import { encodeFrame, FrameParser, CorruptFrameError, TYPE_SET, TYPE_DEL } from '../src/codec.js';

const B = (s) => Buffer.from(s);

async function tmpWalPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-wal-'));
  return { dir, file: path.join(dir, 'db.wal') };
}

function parseAll(buf) {
  return [...new FrameParser().feed(buf)];
}

test('append then read back preserves frames and order', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'everysec' });
    await wal.open();
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('a'), value: B('1') }));
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('b'), value: B('2') }));
    await wal.append(encodeFrame({ type: TYPE_DEL, key: B('a') }));
    await wal.close();

    const frames = parseAll(await fs.readFile(file));
    assert.equal(frames.length, 3);
    assert.equal(frames[0].key.toString(), 'a');
    assert.equal(frames[1].key.toString(), 'b');
    assert.equal(frames[2].type, TYPE_DEL);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('group commit: many concurrent appends all land in order', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'no' });
    await wal.open();
    const N = 1000;
    const ops = [];
    for (let i = 0; i < N; i++) {
      ops.push(wal.append(encodeFrame({ type: TYPE_SET, key: B(`k${i}`), value: B(`${i}`) })));
    }
    await Promise.all(ops);
    await wal.close();

    const frames = parseAll(await fs.readFile(file));
    assert.equal(frames.length, N);
    // Spot-check ordering.
    assert.equal(frames[0].key.toString(), 'k0');
    assert.equal(frames[N - 1].key.toString(), `k${N - 1}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("fsyncPolicy 'always' works", async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'always' });
    await wal.open();
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('durable'), value: B('yes') }));
    await wal.close();
    const frames = parseAll(await fs.readFile(file));
    assert.equal(frames[0].key.toString(), 'durable');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('recovery truncates a torn/corrupt tail at the error offset', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'no' });
    await wal.open();
    const N = 50;
    for (let i = 0; i < N; i++) {
      await wal.append(encodeFrame({ type: TYPE_SET, key: B(`key${i}`), value: B('v') }));
    }
    await wal.close();

    const validSize = (await fs.stat(file)).size;
    // Simulate a crash that left a half-written frame at the end.
    const partial = encodeFrame({ type: TYPE_SET, key: B('torn'), value: B('x'.repeat(100)) }).subarray(0, 13);
    await fs.appendFile(file, partial);

    const buf = await fs.readFile(file);
    const parser = new FrameParser();
    const frames = [];
    let err = null;
    try {
      for (const f of parser.feed(buf)) frames.push(f);
      parser.finish();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof CorruptFrameError, 'expected a corrupt-frame error');
    assert.equal(err.offset, validSize, 'error offset should equal end of valid data');
    assert.equal(frames.length, N, 'all valid frames before the tail are recovered');

    // Truncate at the error offset and verify the file is clean again.
    await fs.truncate(file, err.offset);
    const after = parseAll(await fs.readFile(file));
    assert.equal(after.length, N);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
