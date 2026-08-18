// Regression tests for the deep-review fixes.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';
import { WAL } from '../src/wal.js';
import { barrier } from './helpers.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-fix-'));
}

// --- P0: WAL.flush() must drain frames queued behind an in-flight batch -----

test('WAL.flush() drains frames queued behind an in-flight batch', async () => {
  const dir = await tmpDir();
  try {
    const wal = new WAL(path.join(dir, 'a.wal'), { fsyncPolicy: 'always' });
    await wal.open();
    // Deterministic barrier instead of the old two-setImmediate guess (review
    // #28): the first writev parks, so batch A is PROVABLY in flight when B
    // is appended behind it.
    const fh = (wal as unknown as { fh: { writev: (...a: unknown[]) => Promise<unknown> } }).fh;
    const gate = barrier(fh, 'writev', 1);
    const pA = wal.append(Buffer.alloc(1024 * 1024, 0x61));
    await gate.entered; // batch A is inside writev now
    const pB = wal.append(Buffer.from('B')); // queued behind the in-flight batch
    const flushing = wal.flush(); // must await A AND then drain B
    gate.release();
    await flushing;
    const pending = (wal as unknown as { queue: unknown[] }).queue.length;
    gate.restore();
    await wal.close();
    await pA;
    await pB;
    assert.equal(pending, 0, 'flush() must leave nothing queued');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- P0: TTL expiration must drop derived index entries ---------------------

test('expired keys are removed from secondary indexes', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', activeExpireIntervalMs: 20 });
    await db.createIndex('byCity', { field: 'city' });
    await db.set('u1', { city: 'Paris' }, { ttl: 30 });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(db.get('u1'), undefined);
    assert.deepEqual(db.findEq('byCity', 'Paris'), []);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('expired keys are removed from the full-text index', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', activeExpireIntervalMs: 20 });
    await db.createTextIndex('body');
    await db.set('p1', { bio: 'hello world' }, { ttl: 30 });
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(db.search('body', 'hello'), []);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- P1: recovery must drop records whose TTL already elapsed ---------------

test('recovery drops expired records (size consistent with scan)', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', activeExpireIntervalMs: 0 });
    await db.set('ephemeral', 'v', { ttl: 1 });
    await db.set('stable', 'ok');
    await new Promise((r) => setTimeout(r, 20));
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string', activeExpireIntervalMs: 0 });
    assert.equal(db.size, 1);
    assert.equal(db.scan().length, 1);
    assert.equal(db.get('ephemeral'), undefined);
    assert.equal(db.get('stable'), 'ok');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- concurrent sets keep the unique index consistent ----------------------

test('concurrent sets cannot both commit the same unique value', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byMail', { field: 'email', unique: true });
    const results = await Promise.allSettled([
      db.set('a', { email: 'shared@example.test' }),
      db.set('b', { email: 'shared@example.test' }),
    ]);
    const committed = results.filter((r) => r.status === 'fulfilled').length;
    const hits = db.findEq('byMail', 'shared@example.test');
    await db.close();
    assert.ok(committed <= 1, `both committed: ${JSON.stringify(hits)}`);
    assert.ok(hits.length <= 1, `unique violated: ${JSON.stringify(hits)}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
