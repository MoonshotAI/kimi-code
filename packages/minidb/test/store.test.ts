// test/store.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

const B = (s) => Buffer.from(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('basic set/get/del/has/size', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  s.set('a', B('1'));
  s.set('b', B('2'));
  assert.equal(s.get('a').toString(), '1');
  assert.equal(s.size, 2);
  assert.ok(s.has('a'));
  assert.ok(s.del('a'));
  assert.ok(!s.has('a'));
  assert.equal(s.size, 1);
});

test('keys are binary-safe (Buffer keys, arbitrary bytes)', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  const k = Buffer.from([0x00, 0xff, 0x10, 0x00]);
  s.set(k, B('bin'));
  assert.equal(s.get(Buffer.from([0x00, 0xff, 0x10, 0x00])).toString(), 'bin');
  assert.equal(s.size, 1);
});

test('overwrite updates value without growing size', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  s.set('x', B('1'));
  s.set('x', B('2'));
  assert.equal(s.size, 1);
  assert.equal(s.get('x').toString(), '2');
});

test('lazy expiration on get', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  s.set('soon', B('gone'), Date.now() - 1); // already expired
  assert.equal(s.get('soon'), undefined);
  assert.equal(s.size, 0);
});

test('active expiration sweep removes due keys', async () => {
  const s = new Store({ activeExpireIntervalMs: 10, activeExpireMaxPerTick: 100 });
  s.set('e1', B('v'), Date.now() + 20);
  s.set('e2', B('v'), Date.now() + 20);
  s.set('keep', B('v')); // no ttl
  assert.equal(s.map.size, 3);
  await sleep(80); // several sweep ticks
  assert.equal(s.map.size, 1);
  assert.equal(s.get('keep').toString(), 'v');
  s.close();
});

test('overwriting a TTL key clears the old expiration (stale heap entry skipped)', async () => {
  const s = new Store({ activeExpireIntervalMs: 10, activeExpireMaxPerTick: 100 });
  s.set('k', B('tmp'), Date.now() + 20); // expires soon
  s.set('k', B('persist')); // overwritten with NO ttl
  await sleep(80);
  assert.equal(s.get('k').toString(), 'persist');
  s.close();
});

test('entries() yields only live entries', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  s.set('a', B('1'));
  s.set('b', B('2'), Date.now() - 1); // expired
  const rows = [...s.entries()];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key.toString(), 'a');
});

test('ordered scan over keys (range)', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  ['c', 'a', 'd', 'b'].forEach((k) => s.set(k, B(k)));
  assert.deepEqual(
    [...s.scan({ gte: 'b', lte: 'd' })].map((r) => r.key.toString()),
    ['b', 'c', 'd'],
  );
});

test('prefix scan over keys', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  ['user:1', 'user:2', 'user:10', 'order:1'].forEach((k) => s.set(k, B(k)));
  assert.deepEqual(
    [...s.prefix('user:')].map((r) => r.key.toString()),
    ['user:1', 'user:10', 'user:2'],
  );
});

test('stores dt per record and exposes via getRecord', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  s.set('k', B('v'), 0, { dt1: 1000, dt2: 2000 });
  const r = s.getRecord('k');
  assert.deepEqual(r.dt, { dt1: 1000, dt2: 2000 });
  assert.equal([...s.entries()][0].dt.dt1, 1000);
});

test('delete removes key from the ordered index', () => {
  const s = new Store({ activeExpireIntervalMs: 0 });
  ['a', 'b', 'c'].forEach((k) => s.set(k, B(k)));
  s.del('b');
  assert.deepEqual([...s.scan()].map((r) => r.key.toString()), ['a', 'c']);
});
