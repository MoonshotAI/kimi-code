import { describe, expect, it } from 'vitest';

import {
  fsEntrySchema,
  fsGitStatusEntrySchema,
  fsGitStatusSchema,
  fsGrepFileHitSchema,
  fsGrepMatchSchema,
  fsKindSchema,
  fsSearchHitSchema,
  fsSuggestItemSchema,
  type FsEntry,
  type FsGitStatusEntry,
  type FsGrepFileHit,
  type FsGrepMatch,
  type FsSearchHit,
  type FsSuggestItem,
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

describe('fsSuggestItemSchema', () => {
  const item: FsSuggestItem = {
    path: 'apps/desktop',
    name: 'desktop',
    kind: 'directory',
    score: 0.87,
    match_positions: [5, 6],
  };

  it('round-trips a populated item', () => {
    expect(fsSuggestItemSchema.parse(item)).toEqual(item);
  });

  it('rejects score outside 0..1', () => {
    expect(fsSuggestItemSchema.safeParse({ ...item, score: 1.5 }).success).toBe(false);
    expect(fsSuggestItemSchema.safeParse({ ...item, score: -0.1 }).success).toBe(false);
  });

  it('rejects negative match positions', () => {
    expect(
      fsSuggestItemSchema.safeParse({ ...item, match_positions: [-1] }).success,
    ).toBe(false);
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
