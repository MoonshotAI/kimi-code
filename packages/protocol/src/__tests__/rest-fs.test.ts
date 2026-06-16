import { describe, expect, it } from 'vitest';

import {
  fsDownloadParamsSchema,
  fsGitStatusRequestSchema,
  fsGitStatusResponseSchema,
  fsGrepRequestSchema,
  fsGrepResponseSchema,
  fsListManyRequestSchema,
  fsListManyResponseSchema,
  fsListRequestSchema,
  fsListResponseSchema,
  fsMkdirRequestSchema,
  fsMkdirResponseSchema,
  fsReadRequestSchema,
  fsReadResponseSchema,
  fsSearchRequestSchema,
  fsSearchResponseSchema,
  fsStatManyRequestSchema,
  fsStatManyResponseSchema,
  fsStatRequestSchema,
} from '../rest/fs';

describe('fsListRequestSchema', () => {
  it('applies all defaults on empty body', () => {
    const parsed = fsListRequestSchema.parse({});
    expect(parsed).toEqual({
      path: '.',
      depth: 1,
      limit: 200,
      show_hidden: false,
      follow_gitignore: true,
      sort: 'type_first',
      include_git_status: false,
    });
  });

  it('round-trips a fully populated request', () => {
    const body = {
      path: 'src',
      depth: 3,
      limit: 500,
      show_hidden: true,
      follow_gitignore: false,
      exclude_globs: ['**/node_modules/**'],
      sort: 'mtime_desc' as const,
      include_git_status: true,
    };
    expect(fsListRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects depth > 10', () => {
    expect(fsListRequestSchema.safeParse({ depth: 11 }).success).toBe(false);
  });

  it('rejects limit > 1000', () => {
    expect(fsListRequestSchema.safeParse({ limit: 1001 }).success).toBe(false);
  });
});

describe('fsListResponseSchema', () => {
  it('round-trips an empty truncated:false response', () => {
    expect(
      fsListResponseSchema.parse({ items: [], truncated: false }),
    ).toEqual({ items: [], truncated: false });
  });

  it('round-trips a response with children_by_path', () => {
    const r = {
      items: [
        {
          path: 'src',
          name: 'src',
          kind: 'directory' as const,
          modified_at: '2026-06-04T10:00:00.000Z',
          child_count: 2,
        },
      ],
      children_by_path: {
        src: [
          {
            path: 'src/index.ts',
            name: 'index.ts',
            kind: 'file' as const,
            size: 100,
            modified_at: '2026-06-04T10:00:00.000Z',
          },
        ],
      },
      truncated: false,
    };
    expect(fsListResponseSchema.parse(r)).toEqual(r);
  });
});

describe('fsReadRequestSchema', () => {
  it('applies defaults', () => {
    const parsed = fsReadRequestSchema.parse({ path: 'a.ts' });
    expect(parsed).toEqual({
      path: 'a.ts',
      offset: 0,
      length: 1_048_576,
      encoding: 'auto',
    });
  });

  it('rejects length > 10 MB', () => {
    expect(
      fsReadRequestSchema.safeParse({ path: 'a', length: 10_485_761 }).success,
    ).toBe(false);
  });

  it('rejects empty path', () => {
    expect(fsReadRequestSchema.safeParse({ path: '' }).success).toBe(false);
  });

  it('rejects negative offset', () => {
    expect(
      fsReadRequestSchema.safeParse({ path: 'a', offset: -1 }).success,
    ).toBe(false);
  });
});

describe('fsReadResponseSchema', () => {
  it('round-trips a text response', () => {
    const r = {
      path: 'a.ts',
      content: 'hello',
      encoding: 'utf-8' as const,
      size: 5,
      truncated: false,
      etag: 'deadbeef',
      mime: 'text/typescript',
      language_id: 'typescript',
      line_count: 1,
      is_binary: false,
    };
    expect(fsReadResponseSchema.parse(r)).toEqual(r);
  });

  it('round-trips a base64 response with line_count omitted', () => {
    const r = {
      path: 'a.png',
      content: 'iVBORw0KGgo=',
      encoding: 'base64' as const,
      size: 9,
      truncated: false,
      etag: 'cafebabe',
      mime: 'image/png',
      is_binary: true,
    };
    expect(fsReadResponseSchema.parse(r)).toEqual(r);
  });
});

describe('fsListManyRequestSchema', () => {
  it('requires at least one path', () => {
    expect(fsListManyRequestSchema.safeParse({ paths: [] }).success).toBe(false);
  });

  it('caps paths at 100', () => {
    const paths = Array.from({ length: 101 }, (_, i) => `p${i}`);
    expect(fsListManyRequestSchema.safeParse({ paths }).success).toBe(false);
  });

  it('applies depth/limit defaults', () => {
    const parsed = fsListManyRequestSchema.parse({ paths: ['a', 'b'] });
    expect(parsed.depth).toBe(1);
    expect(parsed.limit).toBe(200);
  });
});

describe('fsListManyResponseSchema', () => {
  it('round-trips a per-path results map with partial_errors', () => {
    const r = {
      results: {
        src: [
          {
            path: 'src/index.ts',
            name: 'index.ts',
            kind: 'file' as const,
            size: 100,
            modified_at: '2026-06-04T10:00:00.000Z',
          },
        ],
      },
      partial_errors: {
        'does/not/exist': { code: 40409, msg: 'fs.path_not_found' },
      },
    };
    expect(fsListManyResponseSchema.parse(r)).toEqual(r);
  });
});

describe('fsStatRequestSchema', () => {
  it('requires non-empty path', () => {
    expect(fsStatRequestSchema.safeParse({ path: '' }).success).toBe(false);
    expect(fsStatRequestSchema.parse({ path: 'a' })).toEqual({ path: 'a' });
  });
});

describe('fsStatManyRequestSchema', () => {
  it('caps paths at 1000', () => {
    const paths = Array.from({ length: 1001 }, (_, i) => `p${i}`);
    expect(fsStatManyRequestSchema.safeParse({ paths }).success).toBe(false);
  });

  it('accepts exactly 1000 paths', () => {
    const paths = Array.from({ length: 1000 }, (_, i) => `p${i}`);
    expect(fsStatManyRequestSchema.safeParse({ paths }).success).toBe(true);
  });

  it('rejects empty paths array', () => {
    expect(fsStatManyRequestSchema.safeParse({ paths: [] }).success).toBe(false);
  });
});

describe('fsStatManyResponseSchema', () => {
  it('accepts null per-path entries (miss marker)', () => {
    const r = {
      entries: {
        present: {
          path: 'present',
          name: 'present',
          kind: 'file' as const,
          modified_at: '2026-06-04T10:00:00.000Z',
        },
        missing: null,
      },
    };
    expect(fsStatManyResponseSchema.parse(r)).toEqual(r);
  });
});

describe('fsSearchRequestSchema (W11.1)', () => {
  it('applies all defaults on minimal body', () => {
    const parsed = fsSearchRequestSchema.parse({ query: 'Button' });
    expect(parsed).toEqual({
      query: 'Button',
      limit: 50,
      follow_gitignore: true,
    });
  });

  it('rejects empty query', () => {
    expect(fsSearchRequestSchema.safeParse({ query: '' }).success).toBe(false);
  });

  it('caps limit at 200', () => {
    expect(fsSearchRequestSchema.safeParse({ query: 'a', limit: 201 }).success).toBe(false);
    expect(fsSearchRequestSchema.safeParse({ query: 'a', limit: 200 }).success).toBe(true);
  });

  it('round-trips include / exclude globs', () => {
    const body = {
      query: 'a',
      limit: 100,
      include_globs: ['**/*.ts'],
      exclude_globs: ['**/node_modules/**'],
      follow_gitignore: false,
    };
    expect(fsSearchRequestSchema.parse(body)).toEqual(body);
  });
});

describe('fsSearchResponseSchema (W11.1)', () => {
  it('round-trips an empty response', () => {
    expect(fsSearchResponseSchema.parse({ items: [], truncated: false }))
      .toEqual({ items: [], truncated: false });
  });

  it('round-trips a populated response', () => {
    const r = {
      items: [
        {
          path: 'src/Button.tsx',
          name: 'Button.tsx',
          kind: 'file' as const,
          score: 0.9,
          match_positions: [4, 5, 6, 7, 8, 9],
        },
      ],
      truncated: true,
    };
    expect(fsSearchResponseSchema.parse(r)).toEqual(r);
  });
});

describe('fsGrepRequestSchema (W11.1)', () => {
  it('applies all REST.md §3.9 defaults', () => {
    const parsed = fsGrepRequestSchema.parse({ pattern: 'hello' });
    expect(parsed).toEqual({
      pattern: 'hello',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 2,
    });
  });

  it('rejects empty pattern', () => {
    expect(fsGrepRequestSchema.safeParse({ pattern: '' }).success).toBe(false);
  });

  it('rejects context_lines > 10', () => {
    expect(
      fsGrepRequestSchema.safeParse({ pattern: 'a', context_lines: 11 }).success,
    ).toBe(false);
  });

  it('accepts a regex pattern', () => {
    const parsed = fsGrepRequestSchema.parse({
      pattern: 'foo|bar',
      regex: true,
    });
    expect(parsed.regex).toBe(true);
  });
});

describe('fsGrepResponseSchema (W11.1)', () => {
  it('round-trips an empty response', () => {
    expect(
      fsGrepResponseSchema.parse({
        files: [],
        files_scanned: 0,
        truncated: false,
        elapsed_ms: 12,
      }),
    ).toEqual({ files: [], files_scanned: 0, truncated: false, elapsed_ms: 12 });
  });

  it('round-trips a populated response', () => {
    const r = {
      files: [
        {
          path: 'src/index.ts',
          matches: [
            {
              line: 1,
              col: 1,
              text: 'console.log("hello");',
              before: [],
              after: [],
            },
          ],
        },
      ],
      files_scanned: 42,
      truncated: false,
      elapsed_ms: 87,
    };
    expect(fsGrepResponseSchema.parse(r)).toEqual(r);
  });
});

describe('fsGitStatusRequestSchema (W11.2)', () => {
  it('accepts an empty body', () => {
    expect(fsGitStatusRequestSchema.parse({})).toEqual({});
  });

  it('accepts an explicit paths filter', () => {
    const parsed = fsGitStatusRequestSchema.parse({ paths: ['a', 'b'] });
    expect(parsed.paths).toEqual(['a', 'b']);
  });

  it('rejects empty path strings inside paths', () => {
    expect(
      fsGitStatusRequestSchema.safeParse({ paths: [''] }).success,
    ).toBe(false);
  });
});

describe('fsGitStatusResponseSchema (W11.2)', () => {
  it('round-trips a clean tree response', () => {
    const r = {
      branch: 'main',
      ahead: 0,
      behind: 0,
      entries: {},
      additions: 0,
      deletions: 0,
      pullRequest: null,
    };
    expect(fsGitStatusResponseSchema.parse(r)).toEqual(r);
  });

  it('round-trips a dirty tree response', () => {
    const r = {
      branch: 'feat/web',
      ahead: 2,
      behind: 1,
      entries: {
        'src/index.ts': 'modified' as const,
        'src/new.ts': 'untracked' as const,
        'src/old.ts': 'deleted' as const,
      },
      additions: 42,
      deletions: 7,
      pullRequest: {
        number: 625,
        state: 'open' as const,
        url: 'https://github.com/MoonshotAI/kimi-code/pull/625',
      },
    };
    expect(fsGitStatusResponseSchema.parse(r)).toEqual(r);
  });

  it('accepts empty branch (detached HEAD)', () => {
    expect(
      fsGitStatusResponseSchema.parse({
        branch: '',
        ahead: 0,
        behind: 0,
        entries: {},
        additions: 0,
        deletions: 0,
        pullRequest: null,
      }).branch,
    ).toBe('');
  });
});

describe('fsDownloadParamsSchema (W11.3)', () => {
  it('parses a minimal path', () => {
    expect(fsDownloadParamsSchema.parse({ path: 'a.txt' })).toEqual({
      path: 'a.txt',
    });
  });

  it('parses range + if-none-match headers', () => {
    const p = {
      path: 'big.bin',
      range: 'bytes=0-65535',
      if_none_match: 'cafebabe',
    };
    expect(fsDownloadParamsSchema.parse(p)).toEqual(p);
  });

  it('rejects empty path', () => {
    expect(fsDownloadParamsSchema.safeParse({ path: '' }).success).toBe(false);
  });
});

describe('fsMkdirRequestSchema', () => {
  it('applies recursive default', () => {
    expect(fsMkdirRequestSchema.parse({ path: 'a' })).toEqual({
      path: 'a',
      recursive: false,
    });
  });

  it('accepts recursive:true', () => {
    expect(fsMkdirRequestSchema.parse({ path: 'a/b', recursive: true })).toEqual({
      path: 'a/b',
      recursive: true,
    });
  });

  it('rejects empty path', () => {
    expect(fsMkdirRequestSchema.safeParse({ path: '' }).success).toBe(false);
  });

  it('rejects missing path', () => {
    expect(fsMkdirRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('fsMkdirResponseSchema', () => {
  it('round-trips a directory entry', () => {
    const entry = {
      path: 'a',
      name: 'a',
      kind: 'directory' as const,
      modified_at: '2026-06-16T08:00:00.000Z',
      etag: 'deadbeef',
    };
    expect(fsMkdirResponseSchema.parse(entry)).toEqual(entry);
  });
});
