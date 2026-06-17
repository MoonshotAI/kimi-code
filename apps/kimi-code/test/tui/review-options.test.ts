import { describe, expect, it } from 'vitest';

import type { ReviewArtifact, ReviewResult } from '@moonshot-ai/kimi-code-sdk';

import {
  buildReviewArtifactSummaryData,
  buildReviewSummaryData,
  formatRelativeTime,
  formatReviewArtifactMarkdown,
  resolveTtyLocale,
  reviewCommitChoice,
  reviewCommitStatAlign,
} from '#/tui/utils/review-options';

const ANSI_SGR = /\[[0-9;]*m/g;
const strip = (text: string) => text.replaceAll(ANSI_SGR, '');

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

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-06-16T12:00:00Z');

  it('formats recent times with Intl relative units', () => {
    expect(formatRelativeTime('2026-06-16T10:00:00Z', now, 'en')).toBe('2 hours ago');
    expect(formatRelativeTime('2026-06-15T12:00:00Z', now, 'en')).toBe('yesterday');
    expect(formatRelativeTime('2026-06-09T12:00:00Z', now, 'en')).toBe('last week');
    expect(formatRelativeTime('2026-03-16T12:00:00Z', now, 'en')).toBe('3 months ago');
  });

  it('returns empty for an unparseable date', () => {
    expect(formatRelativeTime('not-a-date', now, 'en')).toBe('');
  });

  it('does not throw on a malformed locale and still formats', () => {
    expect(formatRelativeTime('2026-06-16T10:00:00Z', now, 'not a locale!!')).toBe('2 hours ago');
  });
});

describe('resolveTtyLocale', () => {
  it('parses POSIX locale env vars into BCP-47 tags', () => {
    expect(resolveTtyLocale({ LANG: 'fr_FR.UTF-8' })).toBe('fr-FR');
    expect(resolveTtyLocale({ LC_ALL: 'de_DE.UTF-8', LANG: 'en_US.UTF-8' })).toBe('de-DE');
    expect(resolveTtyLocale({ LANGUAGE: 'es_ES:en' })).toBe('es-ES');
    expect(resolveTtyLocale({ LANG: 'zh_CN.UTF-8@pinyin' })).toBe('zh-CN');
  });

  it('falls back to en for unset, C, or POSIX locales', () => {
    expect(resolveTtyLocale({})).toBe('en');
    expect(resolveTtyLocale({ LANG: 'C' })).toBe('en');
    expect(resolveTtyLocale({ LC_ALL: 'POSIX' })).toBe('en');
  });
});

describe('reviewCommitChoice', () => {
  const base = {
    sha: '3980a555807687914079243f9476fef93cbfd081',
    title: 'feat(review): run deep review through AgentSwarm',
    date: '2026-06-16T10:00:00Z',
    filesChanged: 3,
    additions: 40,
    deletions: 10,
    hasBody: false,
  };

  it('uses an 8-char short hash and a searchable label', () => {
    const choice = reviewCommitChoice(base);
    expect(choice.value).toBe(base.sha);
    expect(choice.label).toBe('3980a555 feat(review): run deep review through AgentSwarm');
  });

  it('builds search text from hash, message, author, email, and refs', () => {
    const choice = reviewCommitChoice({
      ...base,
      author: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      body: 'rationale in the body',
      refs: ['feature/login', 'v1.2.0'],
    });
    const search = choice.searchText ?? '';
    expect(search).toContain(base.sha); // full hash
    expect(search).toContain('3980a555'); // short hash
    expect(search).toContain('Ada Lovelace');
    expect(search).toContain('ada@example.com');
    expect(search).toContain('rationale in the body');
    expect(search).toContain('feature/login');
    expect(search).toContain('v1.2.0');
  });

  it('renders the hash, bold title, and colored stats line', () => {
    const [head, meta] = reviewCommitChoice(base).render!(false, 120).map(strip);
    expect(head).toContain('3980a555');
    expect(head).toContain('feat(review): run deep review through AgentSwarm');
    expect(meta).toContain('3 files');
    expect(meta).toContain('+40');
    expect(meta).toContain('-10');
  });

  it('marks a commit with a body using ↵', () => {
    const [head] = reviewCommitChoice({ ...base, hasBody: true }).render!(false, 120).map(strip);
    expect(head).toContain('↵');
  });

  it('truncates a long subject with an ellipsis to fit one line', () => {
    const long = { ...base, title: 'x'.repeat(200), hasBody: false };
    const lines = reviewCommitChoice(long).render!(false, 40);
    const head = strip(lines[0]!);
    expect(head).toContain('…');
    expect(head.split('\n')).toHaveLength(1);
  });

  it('omits the stats line when no shortstat is available', () => {
    const merge = { sha: 'abc123def', title: 'merge', filesChanged: undefined };
    const lines = reviewCommitChoice(merge).render!(false, 120);
    expect(lines).toHaveLength(1);
  });

  it('right-aligns and column-aligns the stats across a commit list', () => {
    const commits = [
      { sha: 'a1', title: 'one', filesChanged: 3, additions: 38, deletions: 13 },
      { sha: 'b2', title: 'two', filesChanged: 12, additions: 5, deletions: 120 },
      { sha: 'c3', title: 'three', filesChanged: 1, additions: 0, deletions: 8 },
    ];
    const align = reviewCommitStatAlign(commits);
    const metas = commits.map((commit) => strip(reviewCommitChoice(commit, align).render!(false, 120)[1]!));

    // File count, +additions and -deletions are right-aligned into fixed columns.
    expect(metas[0]).toBe(' 3 files +38  -13');
    expect(metas[1]).toBe('12 files  +5 -120');
    expect(metas[2]).toBe(' 1 file   +0   -8');
    // Equal length ⇒ every column lines up across rows.
    expect(new Set(metas.map((line) => line.length)).size).toBe(1);
  });
});
