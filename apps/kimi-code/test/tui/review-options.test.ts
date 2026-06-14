import { describe, expect, it } from 'vitest';

import type { ReviewArtifact, ReviewResult } from '@moonshot-ai/kimi-code-sdk';

import {
  buildReviewArtifactSummaryData,
  buildReviewSummaryData,
  formatReviewArtifactMarkdown,
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

describe('buildReviewSummaryData', () => {
  it('captures diffstat, handle, and per-comment data for the colored block', () => {
    const data = buildReviewSummaryData(result({ reviewSlug: 'races-on-login' }));
    expect(data).toMatchObject({ fileCount: 2, additions: 10, deletions: 3, handle: 'races-on-login' });
    expect(data.comments).toHaveLength(2);
    expect(data.comments[0]).toEqual({
      severity: 'critical',
      path: 'src/a.ts',
      line: 8,
      title: 'Races on login',
      rejected: false,
    });
  });

  it('falls back to the numeric id when there is no slug', () => {
    expect(buildReviewSummaryData(result()).handle).toBe('2');
  });
});

describe('buildReviewArtifactSummaryData / formatReviewArtifactMarkdown', () => {
  const artifact: ReviewArtifact = {
    id: 2,
    slug: 'races-on-login',
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

  it('folds rejected state into the summary data', () => {
    const data = buildReviewArtifactSummaryData(artifact);
    expect(data.handle).toBe('races-on-login');
    expect(data.comments.find((c) => c.path === 'src/b.ts')?.rejected).toBe(true);
    expect(data.comments.find((c) => c.path === 'src/a.ts')?.rejected).toBe(false);
  });

  it('exports full Markdown excluding rejected comments from severity groups', () => {
    const md = formatReviewArtifactMarkdown(artifact);
    expect(md).toContain('# Code review: races-on-login');
    expect(md).toContain('## Critical');
    expect(md).toContain('### Races on login');
    expect(md).toContain('`src/a.ts:8`');
    // Rejected comment is not under a severity group, only in the Rejected section.
    expect(md).not.toContain('## Minor');
    expect(md).toContain('## Rejected');
    expect(md).toContain('- ~~src/b.ts:3 — Redundant clone~~');
  });
});
