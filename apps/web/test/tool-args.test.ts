import { describe, expect, it } from 'vitest';
import { argFilePath, num, parseArgRecord, pathDirname, str, urlHost } from '@moonshot-ai/app-components';

describe('parseArgRecord', () => {
  it('parses a JSON object argument', () => {
    expect(parseArgRecord('{"path":"a.ts"}')).toEqual({ path: 'a.ts' });
  });

  it('returns null for non-object / malformed / non-JSON arguments', () => {
    expect(parseArgRecord('[1,2]')).toBeNull();
    expect(parseArgRecord('{broken')).toBeNull();
    expect(parseArgRecord('plain string')).toBeNull();
    expect(parseArgRecord('')).toBeNull();
  });
});

describe('str / num', () => {
  it('narrows typed fields defensively', () => {
    expect(str('x')).toBe('x');
    expect(str('')).toBeUndefined();
    expect(str(1)).toBeUndefined();
    expect(num(2)).toBe(2);
    expect(num('2')).toBeUndefined();
    expect(num(Number.NaN)).toBeUndefined();
  });
});

describe('argFilePath', () => {
  it('reads the path from whichever key the tool used', () => {
    expect(argFilePath({ path: 'a.ts' })).toBe('a.ts');
    expect(argFilePath({ file_path: 'b.ts' })).toBe('b.ts');
    expect(argFilePath({ filePath: 'c.ts' })).toBe('c.ts');
    expect(argFilePath({ filename: 'd.ts' })).toBe('d.ts');
    expect(argFilePath({ path: 'a.ts', file_path: 'b.ts' })).toBe('a.ts');
    expect(argFilePath({})).toBeUndefined();
    expect(argFilePath(null)).toBeUndefined();
  });
});

describe('pathDirname', () => {
  it('returns everything before the final segment', () => {
    expect(pathDirname('/a/b/c.ts')).toBe('/a/b');
    expect(pathDirname('src/c.ts')).toBe('src');
    expect(pathDirname('c.ts')).toBe('');
    expect(pathDirname('C:\\code\\app\\c.ts')).toBe('C:\\code\\app');
  });
});

describe('urlHost', () => {
  it('reduces a URL to host plus first segment', () => {
    expect(urlHost('https://example.com/path/to')).toBe('example.com/path');
    expect(urlHost('https://example.com')).toBe('example.com');
  });

  it('falls back to stripping the protocol for malformed URLs', () => {
    expect(urlHost('not a url')).toBe('not a url');
    expect(urlHost('https://still not/a url')).toBe('still not/a url');
  });
});
