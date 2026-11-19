import { expect, it } from 'vitest';
import { listMarkerWidth } from './listMarkerWidth';

it('reserves room when a list crosses into double or triple digits', () => {
  expect(listMarkerWidth(1, Array(15).fill(null))).toBe('4ch');
  expect(listMarkerWidth(99, [null, null])).toBe('5ch');
});

it('accounts for explicit values, reversed numbering and negative signs', () => {
  expect(listMarkerWidth(1, [null, 1000, null])).toBe('6ch');
  expect(listMarkerWidth(100, [null, null], true)).toBe('5ch');
  expect(listMarkerWidth(-10, [null, null])).toBe('5ch');
});
