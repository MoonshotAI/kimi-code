import { describe, expect, it } from 'vitest';

import { formatReviewToolActivityLabel } from '#/tui/components/messages/tool-renderers/review';

describe('review tool activity labels', () => {
  it('does not inline multi-line UpdateProgress summaries', () => {
    const label = formatReviewToolActivityLabel('UpdateProgress', {
      status: 'complete',
      summary: [
        'Reviewed the code-review feature diff with a maintainability/tests focus.',
        'Submitted four actionable comments:',
        '',
        '- Critical finding',
        '- Important finding',
      ].join('\n'),
    });

    expect(label).toBe('review progress update: complete (summary recorded)');
  });

  it('does not inline multi-line UpdateProgress blockers', () => {
    const label = formatReviewToolActivityLabel('UpdateProgress', {
      status: 'blocked',
      blocker: 'Cannot continue until the missing file can be read.\nTool returned 429.',
    });

    expect(label).toBe('review progress update: blocked (blocker recorded)');
  });
});
