// test/codec.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  encodeFrame,
  FrameParser,
  CorruptFrameError,
  TYPE_SET,
  TYPE_DEL,
  HEADER_SIZE,
} from '../src/codec.js';

const B = (s) => Buffer.from(s);

test('round-trip SET', () => {
  const f = encodeFrame({ type: TYPE_SET, key: B('foo'), value: B('bar'), expireAt: 123 });
  const p = new FrameParser();
  const out = [...p.feed(f)];
  assert.equal(out.length, 1);
  assert.equal(out[0].type, TYPE_SET);
  assert.equal(out[0].key.toString(), 'foo');
  assert.equal(out[0].value.toString(), 'bar');
  assert.equal(out[0].expireAt, 123);
});

test('round-trip SET with meta', () => {
  const meta = Buffer.from(JSON.stringify({ dt: { dt1: 123 } }));
  const f = encodeFrame({ type: TYPE_SET, key: B('d'), value: B('v'), meta });
  const out = [...new FrameParser().feed(f)];
  assert.equal(out[0].key.toString(), 'd');
  assert.deepEqual(JSON.parse(out[0].meta.toString()), { dt: { dt1: 123 } });
});

test('frame without meta yields meta=null', () => {
  const f = encodeFrame({ type: TYPE_SET, key: B('d'), value: B('v') });
  const out = [...new FrameParser().feed(f)];
  assert.equal(out[0].meta, null);
});

test('round-trip DEL tombstone (empty value)', () => {
  const f = encodeFrame({ type: TYPE_DEL, key: B('gone') });
  const out = [...new FrameParser().feed(f)];
  assert.equal(out[0].type, TYPE_DEL);
  assert.equal(out[0].key.toString(), 'gone');
  assert.equal(out[0].value.length, 0);
});

test('multiple frames in one chunk', () => {
  const a = encodeFrame({ type: TYPE_SET, key: B('a'), value: B('1') });
  const b = encodeFrame({ type: TYPE_SET, key: B('b'), value: B('2') });
  const out = [...new FrameParser().feed(Buffer.concat([a, b]))];
  assert.equal(out.map((r) => r.key.toString()).join(','), 'a,b');
});

test('partial feed across chunks still parses', () => {
  const f = encodeFrame({ type: TYPE_SET, key: B('split'), value: B('x'.repeat(50)) });
  const p = new FrameParser();
  const cut = 7;
  const out1 = [...p.feed(f.subarray(0, cut))];
  assert.equal(out1.length, 0);
  const out2 = [...p.feed(f.subarray(cut))];
  assert.equal(out2.length, 1);
  assert.equal(out2[0].key.toString(), 'split');
  assert.equal(out2[0].value.length, 50);
});

test('crc mismatch throws CorruptFrameError with offset', () => {
  const f = encodeFrame({ type: TYPE_SET, key: B('bad'), value: B('data') });
  const corrupted = Buffer.from(f);
  corrupted[HEADER_SIZE + 1] ^= 0xff; // flip a byte inside the payload
  assert.throws(() => [...new FrameParser().feed(corrupted)], (e) => {
    assert.ok(e instanceof CorruptFrameError);
    assert.equal(e.offset, 0);
    return true;
  });
});

test('finish() reports a torn trailing partial frame at the valid-data offset', () => {
  const p = new FrameParser();
  const good = encodeFrame({ type: TYPE_SET, key: B('ok'), value: B('v') });
  void [...p.feed(good)];
  void [...p.feed(Buffer.from([0x4d, 0x44, 0x01]))]; // magic + type: incomplete header
  assert.throws(
    () => p.finish(),
    (e) => e instanceof CorruptFrameError && e.offset === good.length,
  );
});

test('finish() returns the clean EOF offset when there is no leftover', () => {
  const p = new FrameParser();
  const a = encodeFrame({ type: TYPE_SET, key: B('a'), value: B('1') });
  const b = encodeFrame({ type: TYPE_SET, key: B('b'), value: B('2') });
  void [...p.feed(Buffer.concat([a, b]))];
  assert.equal(p.finish(), a.length + b.length);
});

test('frame length = header + payload + crc trailer', () => {
  const f = encodeFrame({ type: TYPE_SET, key: B('k'), value: B('v') });
  assert.equal(f.length, HEADER_SIZE + 1 + 1 + 4);
});
