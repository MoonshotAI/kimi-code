import { describe, expect, it } from 'vitest';

import {
  fsChangeActionSchema,
  fsChangeEntrySchema,
  fsChangeEventSchema,
  fsChangeKindSchema,
  fsEntrySchema,
  fsGitStatusEntrySchema,
  fsGitStatusSchema,
  fsGrepFileHitSchema,
  fsGrepMatchSchema,
  fsKindSchema,
  fsSearchHitSchema,
  type FsChangeEntry,
  type FsChangeEvent,
  type FsEntry,
  type FsGitStatusEntry,
  type FsGrepFileHit,
  type FsGrepMatch,
  type FsSearchHit,
} from '../fs';

describe('fsKindSchema', () => {
  it.each(['file', 'directory', 'symlink'] as const)('accepts %s', (k) => {
    expect(fsKindSchema.parse(k)).toBe(k);
  });

  it("rejects agent-core-ish 'dir' / 'other' literals", () => {
    expect(fsKindSchema.safeParse('dir').success).toBe(false);
    expect(fsKindSchema.safeParse('other').success).toBe(false);
  });
});

describe('fsGitStatusSchema', () => {
  it.each([
    'clean',
    'modified',
    'added',
    'deleted',
    'renamed',
    'untracked',
    'ignored',
    'conflicted',
  ] as const)('accepts %s', (s) => {
    expect(fsGitStatusSchema.parse(s)).toBe(s);
  });

  it('rejects unknown git status', () => {
    expect(fsGitStatusSchema.safeParse('staged').success).toBe(false);
  });
});

describe('fsEntrySchema', () => {
  const minimal: FsEntry = {
    path: 'src/index.ts',
    name: 'index.ts',
    kind: 'file',
    modified_at: '2026-06-04T10:00:00.000Z',
  };

  it('round-trips a minimal file entry (no optional fields)', () => {
    expect(fsEntrySchema.parse(minimal)).toEqual(minimal);
  });

  it('round-trips a fully populated entry', () => {
    const full: FsEntry = {
      ...minimal,
      size: 1234,
      etag: 'abcdef',
      mime: 'text/typescript',
      language_id: 'typescript',
      is_binary: false,
      git_status: 'modified',
    };
    expect(fsEntrySchema.parse(full)).toEqual(full);
  });

  it('round-trips a directory with child_count', () => {
    const dir: FsEntry = {
      path: 'src',
      name: 'src',
      kind: 'directory',
      modified_at: '2026-06-04T10:00:00.000Z',
      child_count: 42,
    };
    expect(fsEntrySchema.parse(dir).child_count).toBe(42);
  });

  it('round-trips a symlink with is_symlink_to', () => {
    const sym: FsEntry = {
      path: 'link',
      name: 'link',
      kind: 'symlink',
      modified_at: '2026-06-04T10:00:00.000Z',
      is_symlink_to: 'target',
    };
    expect(fsEntrySchema.parse(sym).is_symlink_to).toBe('target');
  });

  it('rejects negative size', () => {
    expect(fsEntrySchema.safeParse({ ...minimal, size: -1 }).success).toBe(false);
  });

  it('rejects malformed modified_at (no timezone)', () => {
    const bad = { ...minimal, modified_at: '2026-06-04T10:00:00' };
    expect(fsEntrySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects negative child_count', () => {
    const bad: unknown = {
      path: 'src',
      name: 'src',
      kind: 'directory',
      modified_at: '2026-06-04T10:00:00.000Z',
      child_count: -1,
    };
    expect(fsEntrySchema.safeParse(bad).success).toBe(false);
  });
});

describe('fsSearchHitSchema (W11.1 / Chain 11)', () => {
  const hit: FsSearchHit = {
    path: 'src/components/Button.tsx',
    name: 'Button.tsx',
    kind: 'file',
    score: 0.87,
    match_positions: [16, 17, 18, 19],
  };

  it('round-trips a populated hit', () => {
    expect(fsSearchHitSchema.parse(hit)).toEqual(hit);
  });

  it('rejects score outside 0..1', () => {
    expect(fsSearchHitSchema.safeParse({ ...hit, score: 1.5 }).success).toBe(false);
    expect(fsSearchHitSchema.safeParse({ ...hit, score: -0.1 }).success).toBe(false);
  });

  it('rejects negative match positions', () => {
    expect(
      fsSearchHitSchema.safeParse({ ...hit, match_positions: [-1] }).success,
    ).toBe(false);
  });

  it('accepts an empty match_positions list', () => {
    expect(fsSearchHitSchema.parse({ ...hit, match_positions: [] }).match_positions).toEqual([]);
  });
});

describe('fsGrepMatchSchema (W11.1 / Chain 11)', () => {
  const match: FsGrepMatch = {
    line: 42,
    col: 7,
    text: '  console.log(message);',
    before: ['function greet() {', '  const message = "hello";'],
    after: ['}', ''],
  };

  it('round-trips a populated match', () => {
    expect(fsGrepMatchSchema.parse(match)).toEqual(match);
  });

  it('rejects zero line / col (1-based)', () => {
    expect(fsGrepMatchSchema.safeParse({ ...match, line: 0 }).success).toBe(false);
    expect(fsGrepMatchSchema.safeParse({ ...match, col: 0 }).success).toBe(false);
  });

  it('accepts empty before / after arrays', () => {
    const m: FsGrepMatch = { ...match, before: [], after: [] };
    expect(fsGrepMatchSchema.parse(m).before).toEqual([]);
  });
});

describe('fsGrepFileHitSchema (W11.1 / Chain 11)', () => {
  it('round-trips a file with one match', () => {
    const fh: FsGrepFileHit = {
      path: 'src/index.ts',
      matches: [
        {
          line: 1,
          col: 1,
          text: 'export {}',
          before: [],
          after: [],
        },
      ],
    };
    expect(fsGrepFileHitSchema.parse(fh)).toEqual(fh);
  });

  it('round-trips a file with multiple matches', () => {
    const fh: FsGrepFileHit = {
      path: 'README.md',
      matches: [
        { line: 1, col: 1, text: '# Project', before: [], after: [] },
        { line: 5, col: 3, text: 'Project description', before: [], after: [] },
      ],
    };
    expect(fsGrepFileHitSchema.parse(fh).matches).toHaveLength(2);
  });
});

describe('fsGitStatusEntrySchema (W11.2 / Chain 12)', () => {
  const entry: FsGitStatusEntry = {
    path: 'src/index.ts',
    status: 'modified',
  };

  it('round-trips a minimal entry', () => {
    expect(fsGitStatusEntrySchema.parse(entry)).toEqual(entry);
  });

  it('round-trips a renamed entry with rename_from', () => {
    const ren: FsGitStatusEntry = {
      path: 'src/new-name.ts',
      status: 'renamed',
      rename_from: 'src/old-name.ts',
    };
    expect(fsGitStatusEntrySchema.parse(ren).rename_from).toBe('src/old-name.ts');
  });

  it('rejects an unknown status', () => {
    expect(
      fsGitStatusEntrySchema.safeParse({ ...entry, status: 'staged' }).success,
    ).toBe(false);
  });
});

describe('fsChangeKindSchema (W12 / Chain 14)', () => {
  it.each(['file', 'directory', 'symlink'] as const)('accepts %s', (k) => {
    expect(fsChangeKindSchema.parse(k)).toBe(k);
  });

  it('rejects unknown kinds (chokidar leakage like "addDir")', () => {
    expect(fsChangeKindSchema.safeParse('addDir').success).toBe(false);
    expect(fsChangeKindSchema.safeParse('dir').success).toBe(false);
  });
});

describe('fsChangeActionSchema (W12 / Chain 14)', () => {
  it.each(['created', 'modified', 'deleted'] as const)(
    'accepts %s',
    (a) => {
      expect(fsChangeActionSchema.parse(a)).toBe(a);
    },
  );

  it('rejects chokidar raw event names (must collapse before wire)', () => {
    for (const raw of ['add', 'change', 'unlink', 'addDir', 'unlinkDir']) {
      expect(fsChangeActionSchema.safeParse(raw).success).toBe(false);
    }
  });
});

describe('fsChangeEntrySchema (W12 / Chain 14)', () => {
  it('round-trips a minimal created-file entry', () => {
    const entry: FsChangeEntry = {
      path: 'src/index.ts',
      change: 'created',
      kind: 'file',
    };
    expect(fsChangeEntrySchema.parse(entry)).toEqual(entry);
  });

  it('accepts size_delta + etag on a modified file', () => {
    const entry: FsChangeEntry = {
      path: 'src/foo.ts',
      change: 'modified',
      kind: 'file',
      size_delta: 17,
      etag: 'abc123',
    };
    const parsed = fsChangeEntrySchema.parse(entry);
    expect(parsed.size_delta).toBe(17);
    expect(parsed.etag).toBe('abc123');
  });

  it('accepts a negative size_delta (file shrank)', () => {
    expect(
      fsChangeEntrySchema.parse({
        path: 'src/big.log',
        change: 'modified',
        kind: 'file',
        size_delta: -1024,
      }).size_delta,
    ).toBe(-1024);
  });

  it('round-trips a deleted-directory entry', () => {
    const entry: FsChangeEntry = {
      path: 'old/',
      change: 'deleted',
      kind: 'directory',
    };
    expect(fsChangeEntrySchema.parse(entry)).toEqual(entry);
  });
});

describe('fsChangeEventSchema (W12 / Chain 14)', () => {
  it('round-trips a non-truncated event with two changes', () => {
    const ev: FsChangeEvent = {
      changes: [
        { path: 'a.txt', change: 'created', kind: 'file' },
        { path: 'b.txt', change: 'modified', kind: 'file', size_delta: 5 },
      ],
      coalesced_window_ms: 200,
    };
    const parsed = fsChangeEventSchema.parse(ev);
    expect(parsed.changes.length).toBe(2);
    expect(parsed.truncated).toBeUndefined();
  });

  it('round-trips a truncated burst notification', () => {
    const ev: FsChangeEvent = {
      changes: [],
      coalesced_window_ms: 200,
      truncated: true,
      count: 1742,
    };
    const parsed = fsChangeEventSchema.parse(ev);
    expect(parsed.truncated).toBe(true);
    expect(parsed.count).toBe(1742);
    expect(parsed.changes).toEqual([]);
  });

  it('rejects a missing coalesced_window_ms (always echoed)', () => {
    expect(
      fsChangeEventSchema.safeParse({ changes: [] }).success,
    ).toBe(false);
  });
});
