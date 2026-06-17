import { describe, expect, it } from 'vitest';

import { formatReviewToolActivityLabel } from '#/tui/components/messages/tool-renderers/review';

describe('review tool activity labels', () => {
  it('specializes file-version reads by source without highlighting paths as the action', () => {
    expect(formatReviewToolActivityLabel('ReadFileVersion', {
      path: 'packages/agent-core/src/review/prompts.ts',
      version: 'current',
      line_offset: 1,
    })).toBe(
      'Read current file state (packages/agent-core/src/review/prompts.ts · from line 1)',
    );

    expect(formatReviewToolActivityLabel('ReadFileVersion', {
      path: 'packages/agent-core/src/review/prompts.ts',
      version: 'base',
      line_offset: 40,
      n_lines: 8,
    })).toBe(
      'Read base file state (packages/agent-core/src/review/prompts.ts · lines 40-47)',
    );

    expect(formatReviewToolActivityLabel('ReadFileVersion', {
      path: 'packages/agent-core/src/review/prompts.ts',
      ref: 'a58b5b20bb42228c72277daba9fa07bb1cd539a6',
      line_offset: 7,
      n_lines: 1,
    })).toBe(
      'Read file at ref (packages/agent-core/src/review/prompts.ts · ref a58b5b2 · line 7)',
    );
  });

  it('keeps review paths in the detail segment for diff and comment tools', () => {
    expect(formatReviewToolActivityLabel('ReadDiff', {
      paths: ['src/a.ts'],
      section_id: 'section-2',
      context_lines: 5,
    })).toBe('Read changed section (src/a.ts · section 2 · 5 nearby lines)');

    expect(formatReviewToolActivityLabel('ReadDiff', {
      paths: ['src/a.ts'],
      context_lines: 0,
    })).toBe('Read changed lines (src/a.ts)');

    expect(formatReviewToolActivityLabel('ReadDiff', {})).toBe('Read changed lines (assigned files)');

    expect(formatReviewToolActivityLabel('AddComment', {
      path: 'src/a.ts',
      line: 12,
      severity: 'important',
      title: 'Validate input',
    })).toBe('Added review comment (src/a.ts:12 · important · Validate input)');
  });

  it('keeps full paths when the terminal width is unknown (no abbreviation)', () => {
    const label = formatReviewToolActivityLabel('AddComment', {
      path: 'packages/agent-core/src/review/artifact.ts',
      line: 146,
      severity: 'critical',
      title: 'Concurrent review saves can overwrite each other',
    });
    expect(label).toContain('packages/agent-core/src/review/artifact.ts:146');
  });

  it('abbreviates long paths only to fit a narrow terminal width', () => {
    const original = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', { value: 60, configurable: true });
    try {
      const label = formatReviewToolActivityLabel('AddComment', {
        path: 'packages/agent-core/src/review/artifact.ts',
        line: 146,
        severity: 'critical',
        title: 'Concurrent review saves can overwrite each other',
      });
      // The path is elided to fit; the file name and line survive.
      expect(label).toContain('artifact.ts:146');
      expect(label).toContain('…');
      expect(label).not.toContain('agent-core/src/review/artifact.ts');
    } finally {
      if (original !== undefined) Object.defineProperty(process.stdout, 'columns', original);
    }
  });

  it('formats legacy ReadPatch records for replay', () => {
    expect(formatReviewToolActivityLabel('ReadPatch', {
      path: 'src/a.ts',
      hunk_id: 'hunk-2',
      context_lines: 5,
    })).toBe('Read changed section (src/a.ts · section 2 · 5 nearby lines)');
  });

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

    expect(label).toBe('Marked review complete (summary recorded)');
  });

  it('does not inline multi-line UpdateProgress blockers', () => {
    const label = formatReviewToolActivityLabel('UpdateProgress', {
      status: 'blocked',
      blocker: 'Cannot continue until the missing file can be read.\nTool returned 429.',
    });

    expect(label).toBe('Marked review blocked (blocker recorded)');
  });
});
