import { describe, expect, it } from 'vitest';

import { parseReviewCommand } from '#/tui/commands/review';
import { escapeMarkdown } from '#/tui/utils/review-options';

describe('parseReviewCommand', () => {
  it('treats read/export with at most one token as subcommands', () => {
    expect(parseReviewCommand('read')).toEqual({ kind: 'read', idArg: undefined });
    expect(parseReviewCommand('read auth-refresh-races')).toEqual({
      kind: 'read',
      idArg: 'auth-refresh-races',
    });
    expect(parseReviewCommand('export 2')).toEqual({ kind: 'export', idArg: '2' });
  });

  it('treats multi-word read/export as a focus, not a subcommand', () => {
    expect(parseReviewCommand('read the auth flow')).toEqual({
      kind: 'start',
      focus: 'read the auth flow',
    });
    expect(parseReviewCommand('export and verify the config loader')).toEqual({
      kind: 'start',
      focus: 'export and verify the config loader',
    });
  });

  it('treats empty input and ordinary focus as a start', () => {
    expect(parseReviewCommand('')).toEqual({ kind: 'start', focus: undefined });
    expect(parseReviewCommand('   ')).toEqual({ kind: 'start', focus: undefined });
    expect(parseReviewCommand('focus on security')).toEqual({
      kind: 'start',
      focus: 'focus on security',
    });
  });
});

describe('escapeMarkdown', () => {
  it('escapes structural Markdown so titles cannot inject headings or code', () => {
    expect(escapeMarkdown('## Reintroduce bug')).toBe('\\#\\# Reintroduce bug');
    expect(escapeMarkdown('use `rm -rf` here')).toBe('use \\`rm -rf\\` here');
    expect(escapeMarkdown('a*b_c~d')).toBe('a\\*b\\_c\\~d');
  });
});
