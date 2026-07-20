import { describe, expect, it } from 'vitest';

import {
  fsBrowseEntrySchema,
  fsBrowseQuerySchema,
  fsBrowseResponseSchema,
  fsHomeResponseSchema,
} from '../rest/fsBrowse';

describe('fsBrowseQuerySchema', () => {
  it('accepts an empty query (path defaults to $HOME at the daemon)', () => {
    expect(fsBrowseQuerySchema.parse({})).toEqual({});
  });

  it('accepts a path string', () => {
    expect(fsBrowseQuerySchema.parse({ path: '/Users/foo' })).toEqual({
      path: '/Users/foo',
    });
  });

  it('rejects empty string path', () => {
    expect(fsBrowseQuerySchema.safeParse({ path: '' }).success).toBe(false);
  });
});

describe('fsBrowseEntrySchema', () => {
  it('round-trips a dir entry', () => {
    const entry = {
      name: 'src',
      path: '/Users/foo/code/src',
      is_dir: true as const,
    };
    expect(fsBrowseEntrySchema.parse(entry)).toEqual(entry);
  });

  it('rejects is_dir=false (only directories are surfaced)', () => {
    const bad = {
      name: 'README.md',
      path: '/Users/foo/code/README.md',
      is_dir: false,
    };
    expect(fsBrowseEntrySchema.safeParse(bad).success).toBe(false);
  });
});

describe('fsBrowseResponseSchema', () => {
  it('accepts a populated response with a non-null parent', () => {
    const resp = {
      path: '/Users/foo/code',
      parent: '/Users/foo',
      entries: [
        {
          name: 'kimi-code',
          path: '/Users/foo/code/kimi-code',
          is_dir: true as const,
        },
      ],
    };
    expect(fsBrowseResponseSchema.parse(resp).entries.length).toBe(1);
  });

  it('accepts parent=null for filesystem roots', () => {
    const resp = {
      path: '/',
      parent: null,
      entries: [],
    };
    expect(fsBrowseResponseSchema.parse(resp).parent).toBeNull();
  });
});

describe('fsHomeResponseSchema', () => {
  it('round-trips an empty recent_roots list', () => {
    expect(
      fsHomeResponseSchema.parse({ home: '/Users/foo', recent_roots: [] }),
    ).toEqual({ home: '/Users/foo', recent_roots: [] });
  });

  it('round-trips a populated recent_roots list', () => {
    const resp = {
      home: '/Users/foo',
      recent_roots: ['/Users/foo/code/kimi-code', '/Users/foo/code/other'],
    };
    expect(fsHomeResponseSchema.parse(resp).recent_roots.length).toBe(2);
  });
});
