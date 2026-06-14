import { describe, expect, it } from 'vitest';

import type { ReviewArtifact, ReviewResult } from '@moonshot-ai/kimi-code-sdk';

import {
  formatReviewArtifactCompactMarkdown,
  formatReviewCompactMarkdown,
} from '#/tui/utils/review-options';

const STATS = {
  fileCount: 2,
  additions: 10,
  deletions: 3,
  files: [],
} as const;

function result(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    target: { scope: 'working_tree' },
    intensity: 'standard',
    status: 'complete',
    stats: STATS,
    summary: 'Reviewed 2 files.',
    reviewId: 2,
    comments: [
      { id: 'c1', sourceCommentIds: [], severity: 'critical', path: 'src/a.ts', line: 8, title: 'Races on login', body: '' },
      { id: 'c2', sourceCommentIds: [], severity: 'minor', path: 'src/b.ts', line: 3, title: 'Redundant clone', body: '' },
    ],
    ...overrides,
  };
}

describe('formatReviewCompactMarkdown', () => {
  it('renders a compact list grouped by severity with the reopen command', () => {
    const text = formatReviewCompactMarkdown(result());
    expect(text).toContain('**Code review** · 2 files: +10 -3 · 2 findings · 1 critical');
    expect(text).toContain('**Critical**');
    expect(text).toContain('- `src/a.ts:8` — Races on login');
    expect(text).toContain('**Minor**');
    expect(text).toContain('/review read 2');
    // The wall-of-text body must not be inlined.
    expect(text).not.toContain('Reviewed 2 files.\n');
  });

  it('falls back to the summary when there are no findings', () => {
    const text = formatReviewCompactMarkdown(result({ comments: [], reviewId: undefined }));
    expect(text).toBe('Reviewed 2 files.');
  });
});

describe('formatReviewArtifactCompactMarkdown', () => {
  const artifact: ReviewArtifact = {
    id: 2,
    createdAt: '2026-06-14T14:30:52Z',
    target: { scope: 'working_tree' },
    intensity: 'standard',
    stats: STATS,
    summary: 'Reviewed 2 files.',
    diff: '',
    comments: [
      {
        id: 'c1',
        severity: 'critical',
        title: 'Races on login',
        body: 'x',
        anchor: { path: 'src/a.ts', side: 'new', line: 8 },
        state: 'candidate',
        dismissal: null,
      },
      {
        id: 'c2',
        severity: 'minor',
        title: 'Redundant clone',
        body: 'y',
        anchor: { path: 'src/b.ts', side: 'new', line: 3 },
        state: 'dismissed',
        dismissal: { reason: 'rejected_by_user' },
      },
    ],
  };

  it('folds rejected comments into a struck-through Rejected group', () => {
    const text = formatReviewArtifactCompactMarkdown(artifact);
    expect(text).toContain('1 finding · 1 critical · 1 rejected');
    expect(text).toContain('**Rejected**');
    expect(text).toContain('- ~~`src/b.ts:3` — Redundant clone~~');
    // The active critical is still listed normally.
    expect(text).toContain('- `src/a.ts:8` — Races on login');
  });
});
