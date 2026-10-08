// test/degrade.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb, classifyStorageError } from '../src/index.js';
import { CorruptFrameError } from '../src/codec.js';
import { LockError } from '../src/lockfile.js';
import { retryEperm } from '../src/rename-replace.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-degrade-'));
}

test('openOrRebuild preserves data when only a sidecar definition file is corrupt', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byX', { field: 'x' });
  await db.set('important', { x: 1 });
  await db.close();

  // Corrupt the index-definitions file so open() throws during load.
  await fs.writeFile(path.join(dir, 'db.indexes.json'), '{ not valid json');

  let rebuilt = null;
  db = await MiniDb.openOrRebuild(
    { dir, valueCodec: 'json' },
    { onRebuild: (e) => (rebuilt = e) },
  );
  assert.ok(rebuilt instanceof Error, 'onRebuild called with the original error');
  // the sidecar (pure derived state) is dropped, the data is NOT wiped
  assert.equal(db.size, 1);
  assert.deepEqual(db.get('important'), { x: 1 });
  assert.deepEqual(db.listIndexes(), []);
  // indexes can be recreated and the db is usable again
  await db.createIndex('byX', { field: 'x' });
  assert.equal(db.findEq('byX', 1).length, 1);
  await db.set('fresh', { v: 1 });
  assert.deepEqual(db.get('fresh'), { v: 1 });
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('openOrRebuild does NOT delete a live-locked db', async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  await db1.set('a', '1');
  try {
    await assert.rejects(() => MiniDb.openOrRebuild({ dir, valueCodec: 'string' }), LockError);
    // data still there
    assert.ok(await fs.stat(path.join(dir, 'db.wal')));
  } finally {
    await db1.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('openOrRebuild with onLockFail readonly must not mutate a live writer: corrupt sidecar is rethrown, not "repaired" (lock-review repro)', async () => {
  const dir = await tmpDir();
  const writer = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
  await writer.set('kept', 'value');
  // A corrupt secondary-index sidecar: a plain readonly open fails on it with
  // a SyntaxError, which openOrRebuild would normally "fix" by dropping the
  // sidecar — but the readonly fallback must never delete a live writer's
  // files.
  await fs.writeFile(path.join(dir, 'db.indexes.json'), '{broken-json');
  try {
    await assert.rejects(
      MiniDb.openOrRebuild<string>({ dir, valueCodec: 'string', fsyncPolicy: 'no', onLockFail: 'readonly' }),
      SyntaxError,
    );
    const sidecar = await fs.readFile(path.join(dir, 'db.indexes.json'), 'utf8');
    assert.equal(sidecar, '{broken-json', 'the live writer’s sidecar is untouched');
    assert.equal(writer.get('kept'), 'value', 'the live writer is undisturbed');
  } finally {
    await writer.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('openOrRebuild with onLockFail readonly + a garbage WAL (strict) degrades to a live read-only view and never wipes the directory (lock-review repro)', async () => {
  const dir = await tmpDir();
  const writer = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
  await writer.set('kept', 'value');
  // A garbage WAL. Strict recovery at HEAD stops at the first bad frame
  // instead of throwing (stage 7/9 semantics), so the readonly open succeeds;
  // the historical bug this pins is the full-directory wipe openOrRebuild ran
  // when such an open DID fail destructively.
  await fs.writeFile(path.join(dir, 'db.wal'), Buffer.from('not-a-valid-frame'));
  const walBefore = await fs.readFile(path.join(dir, 'db.wal'));
  try {
    const rebuilt = await MiniDb.openOrRebuild<string>({
      dir,
      valueCodec: 'string',
      fsyncPolicy: 'no',
      recovery: 'strict',
      onLockFail: 'readonly',
    });
    assert.equal(rebuilt.readOnly, true, 'degraded to read-only behind the live writer');
    assert.equal(rebuilt.get('kept'), undefined, 'the garbage WAL replays nothing');
    await rebuilt.close();
    const walAfter = await fs.readFile(path.join(dir, 'db.wal'));
    assert.ok(walBefore.equals(walAfter), 'the live writer’s WAL is byte-identical');
    assert.equal(writer.get('kept'), 'value', 'the live writer is undisturbed');
    // The writer's own lock line is still on disk (no fresh db was opened
    // over the directory).
    const lockRaw = JSON.parse(await fs.readFile(path.join(dir, 'db.lock'), 'utf8')) as { token?: string };
    assert.equal(typeof lockRaw.token, 'string', 'lock file intact');
  } finally {
    await writer.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('classifyStorageError and retryEperm drive the rebuild/transient recovery policy', async () => {
  const walDisabled = Object.assign(new Error('disabled'), { code: 'WAL_WRITE_DISABLED' });
  const walPoisoned = Object.assign(new Error('poisoned'), { code: 'WAL_POISONED' });
  assert.equal(classifyStorageError(walDisabled), 'rebuild');
  assert.equal(classifyStorageError(walPoisoned), 'rebuild');
  assert.equal(classifyStorageError(new CorruptFrameError('bad frame', 0)), 'rebuild');
  assert.equal(classifyStorageError(new SyntaxError('unexpected token')), 'rebuild');
  assert.equal(classifyStorageError(new AggregateError([new Error('x'), walPoisoned], 'partial')), 'rebuild');
  assert.equal(classifyStorageError(new AggregateError([new Error('x'), new LockError('locked')], 'partial')), 'transient');
  assert.equal(classifyStorageError(new LockError('locked')), 'transient');
  assert.equal(classifyStorageError(Object.assign(new Error('perm'), { code: 'EPERM' })), 'transient');
  assert.equal(classifyStorageError(new Error('unknown')), 'transient');

  const eperm = () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  let attempts = 0;
  const recovered = await retryEperm(async () => {
    attempts += 1;
    if (attempts < 3) throw eperm();
    return 'ok';
  }, { baseDelayMs: 1 });
  assert.equal(recovered, 'ok');
  assert.equal(attempts, 3);

  attempts = 0;
  await assert.rejects(
    retryEperm(async () => {
      attempts += 1;
      throw new Error('not eperm');
    }),
    /not eperm/,
  );
  assert.equal(attempts, 1);

  attempts = 0;
  await assert.rejects(
    retryEperm(async () => {
      attempts += 1;
      throw eperm();
    }, { retries: 2, baseDelayMs: 1 }),
    /operation not permitted/,
  );
  assert.equal(attempts, 3);
});
