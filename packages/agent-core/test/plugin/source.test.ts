import { describe, expect, it } from 'vitest';

import { resolveInstallSource } from '../../src/plugin/source';

describe('resolveInstallSource', () => {
  it('recognizes https:// as zip-url', () => {
    const result = resolveInstallSource('https://example.com/plugin.zip');
    expect(result).toEqual({ kind: 'zip-url', path: 'https://example.com/plugin.zip' });
  });

  it('recognizes http:// as zip-url', () => {
    const result = resolveInstallSource('http://example.com/plugin.zip');
    expect(result).toEqual({ kind: 'zip-url', path: 'http://example.com/plugin.zip' });
  });

  it('recognizes absolute path as local-path', () => {
    const result = resolveInstallSource('/home/user/plugin');
    expect(result).toEqual({ kind: 'local-path', path: '/home/user/plugin' });
  });

  it('trims whitespace from local paths', () => {
    const result = resolveInstallSource('  /home/user/plugin  ');
    expect(result).toEqual({ kind: 'local-path', path: '/home/user/plugin' });
  });

  it('throws for relative local paths', () => {
    expect(() => resolveInstallSource('relative/path')).toThrow(/absolute path/i);
  });

  it('throws for empty string', () => {
    expect(() => resolveInstallSource('')).toThrow(/absolute path/i);
  });
});
