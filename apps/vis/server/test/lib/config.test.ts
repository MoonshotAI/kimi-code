import { describe, it, expect } from 'vitest';
import { hostForUrl } from '../../src/config';

describe('hostForUrl', () => {
  it('brackets a bare IPv6 literal for use in a URL', () => {
    expect(hostForUrl('::1')).toBe('[::1]');
  });

  it('leaves an IPv4 literal unchanged', () => {
    expect(hostForUrl('127.0.0.1')).toBe('127.0.0.1');
  });

  it('leaves a hostname unchanged', () => {
    expect(hostForUrl('localhost')).toBe('localhost');
  });

  it('leaves an already-bracketed IPv6 literal unchanged', () => {
    expect(hostForUrl('[::1]')).toBe('[::1]');
  });
});
