import { describe, expect, it } from 'vitest';
import { resolveOutputStyle, type OutputStyle } from '../../src/output-style';

const styles: readonly OutputStyle[] = [
  { name: 'concise', description: 'd', body: 'b1', source: 'builtin' },
  { name: 'explanatory', description: 'd', body: 'b2', source: 'user' },
];

describe('resolveOutputStyle', () => {
  it('returns the matching style by name', () => {
    expect(resolveOutputStyle(styles, 'explanatory')?.body).toBe('b2');
  });
  it('trims the name before matching', () => {
    expect(resolveOutputStyle(styles, '  concise  ')?.name).toBe('concise');
  });
  it('returns undefined for unknown, empty, or undefined name', () => {
    expect(resolveOutputStyle(styles, 'nope')).toBeUndefined();
    expect(resolveOutputStyle(styles, '')).toBeUndefined();
    expect(resolveOutputStyle(styles, undefined)).toBeUndefined();
  });
});
