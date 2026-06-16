import { describe, expect, it } from 'vitest';

import { ReviewSummaryComponent } from '#/tui/components/messages/review-summary';
import type { ReviewSummaryComment, ReviewSummaryTranscriptData } from '#/tui/types';

const ANSI_SGR = /\[[0-9;]*m/g;

function comment(over: Partial<ReviewSummaryComment>): ReviewSummaryComment {
  return {
    severity: 'important',
    path: 'src/a.ts',
    line: 1,
    title: 'A problem',
    rejected: false,
    ...over,
  };
}

function data(comments: readonly ReviewSummaryComment[], over: Partial<ReviewSummaryTranscriptData> = {}): ReviewSummaryTranscriptData {
  return {
    fileCount: 2,
    additions: 10,
    deletions: 3,
    handle: 'topic-slug',
    summary: 'Review completed.',
    comments,
    ...over,
  };
}

function lines(d: ReviewSummaryTranscriptData, width = 120): string[] {
  return new ReviewSummaryComponent(d).render(width).map((line) => line.replaceAll(ANSI_SGR, ''));
}

describe('ReviewSummaryComponent', () => {
  it('renders a single comment in a file inline when it fits', () => {
    const out = lines(data([comment({ severity: 'critical', path: 'src/auth.ts', line: 88, title: 'Token refresh races' })]));
    expect(out).toContain('   • src/auth.ts:88 — Token refresh races');
  });

  it('splits a long-path single comment onto two lines and abbreviates the path', () => {
    const out = lines(
      data([comment({ path: 'this/is/a/very/long/path/that/keeps/going/here.ts', line: 42, title: 'Off-by-one in the slice bound' })]),
      40,
    );
    const head = out.find((line) => line.includes(':42'));
    const title = out.find((line) => line.includes('Off-by-one in the slice bound'));
    expect(head).toBeDefined();
    expect(title).toBeDefined();
    // path line and title line are distinct
    expect(head).not.toBe(title);
    // the path was abbreviated with the middle-elision helper
    expect(head).toContain('…');
    expect(head!.trim().startsWith('• this')).toBe(true);
  });

  it('groups multiple comments in one file as a nested list with Line N items', () => {
    const out = lines(
      data([
        comment({ path: 'src/api.ts', line: 142, title: 'Missing null check' }),
        comment({ path: 'src/api.ts', line: 207, title: 'Unhandled rejection' }),
      ]),
    );
    expect(out).toContain('   • src/api.ts');
    expect(out.some((line) => line.includes('Line 142:  Missing null check'))).toBe(true);
    expect(out.some((line) => line.includes('Line 207:  Unhandled rejection'))).toBe(true);
    // no inline "path:line — title" form for the grouped file
    expect(out.some((line) => line.includes('src/api.ts:142 —'))).toBe(false);
  });

  it('pads Line N: tags so titles align when line numbers differ in width', () => {
    const out = lines(
      data([
        comment({ path: 'src/api.ts', line: 7, title: 'Short' }),
        comment({ path: 'src/api.ts', line: 142, title: 'Wide' }),
      ]),
    );
    // "Line 7:" is padded to the width of "Line 142:" so both titles start at
    // the same column (tag width 9 + two trailing spaces).
    expect(out.some((line) => line.includes('Line 7:    Short'))).toBe(true);
    expect(out.some((line) => line.includes('Line 142:  Wide'))).toBe(true);
  });

  it('keeps two-level grouping: a file may appear under more than one severity', () => {
    const out = lines(
      data([
        comment({ severity: 'critical', path: 'src/api.ts', line: 10, title: 'Critical issue' }),
        comment({ severity: 'minor', path: 'src/api.ts', line: 20, title: 'Minor nit' }),
      ]),
    );
    const critical = out.indexOf('   Critical');
    const minor = out.indexOf('   Minor');
    expect(critical).toBeGreaterThanOrEqual(0);
    expect(minor).toBeGreaterThan(critical);
    expect(out.some((line) => line.includes('Critical issue'))).toBe(true);
    expect(out.some((line) => line.includes('Minor nit'))).toBe(true);
  });

  it('lists rejected comments in a trailing section', () => {
    const out = lines(data([comment({ rejected: true, path: 'src/foo.ts', line: 7, title: 'Bad call' })]));
    expect(out).toContain('   Rejected');
    expect(out.some((line) => line.includes('src/foo.ts:7 — Bad call'))).toBe(true);
  });

  it('sorts grouped comments by line number', () => {
    const out = lines(
      data([
        comment({ path: 'src/api.ts', line: 207, title: 'Later' }),
        comment({ path: 'src/api.ts', line: 142, title: 'Earlier' }),
      ]),
    );
    const earlier = out.findIndex((line) => line.includes('Earlier'));
    const later = out.findIndex((line) => line.includes('Later'));
    expect(earlier).toBeGreaterThanOrEqual(0);
    expect(later).toBeGreaterThan(earlier);
  });

  it('shows a gray follow-up tip on the browsed note when there are comments', () => {
    const out = lines(data([comment({ rejected: true })], { variant: 'browsed' }));
    expect(out).toContain('  Tips: Ask Kimi to fix these comments, or discuss them here in chat.');
  });

  it('omits the follow-up hint on the browsed note when there are no comments', () => {
    const out = lines(data([], { variant: 'browsed' }));
    expect(out.some((line) => line.includes('Ask Kimi to fix'))).toBe(false);
  });
});
