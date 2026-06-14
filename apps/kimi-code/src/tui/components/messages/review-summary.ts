/**
 * ReviewSummaryComponent — the compact, colored review block shown in the
 * transcript after a review completes (and re-rendered after reject in the
 * reader). Unlike the plain Markdown render it can color the bullet, the
 * diffstat, and the counts.
 */

import { truncateToWidth, type Component } from '@earendil-works/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme, type ColorToken } from '#/tui/theme';
import type { ReviewSummaryComment, ReviewSummaryTranscriptData } from '#/tui/types';

const SEVERITY_ORDER = ['critical', 'important', 'minor'] as const;
const SEVERITY_LABEL: Record<ReviewSummaryComment['severity'], string> = {
  critical: 'Critical',
  important: 'Important',
  minor: 'Minor',
};
const SEVERITY_COLOR: Record<ReviewSummaryComment['severity'], ColorToken> = {
  critical: 'error',
  important: 'warning',
  minor: 'textDim',
};

export class ReviewSummaryComponent implements Component {
  constructor(private readonly data: ReviewSummaryTranscriptData) {}

  invalidate(): void {}

  render(width: number): string[] {
    const active = this.data.comments.filter((comment) => !comment.rejected);
    const rejected = this.data.comments.filter((comment) => comment.rejected);
    if (active.length === 0 && rejected.length === 0) {
      return ['', currentTheme.boldFg('success', STATUS_BULLET) + currentTheme.fg('text', this.data.summary)]
        .map((line) => truncateToWidth(line, width));
    }

    const lines = ['', this.headerLine(active, rejected.length)];
    for (const severity of SEVERITY_ORDER) {
      const group = active.filter((comment) => comment.severity === severity);
      if (group.length === 0) continue;
      lines.push('');
      lines.push('   ' + currentTheme.boldFg(SEVERITY_COLOR[severity], SEVERITY_LABEL[severity]));
      for (const comment of group) lines.push('   ' + commentLine(comment, false));
    }
    if (rejected.length > 0) {
      lines.push('');
      lines.push('   ' + currentTheme.boldFg('textDim', 'Rejected'));
      for (const comment of rejected) lines.push('   ' + commentLine(comment, true));
    }
    if (this.data.handle !== undefined) {
      lines.push('');
      lines.push(
        '   ' +
          currentTheme.fg('textDim', 'Browse or reject: ') +
          currentTheme.fg('primary', `/review read ${this.data.handle}`),
      );
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  private headerLine(active: readonly ReviewSummaryComment[], rejectedCount: number): string {
    const critical = active.filter((comment) => comment.severity === 'critical').length;
    const dot = currentTheme.fg('textDim', ' · ');
    let header =
      currentTheme.boldFg('success', `${STATUS_BULLET}Code review`) +
      dot +
      currentTheme.fg('text', `${String(this.data.fileCount)} ${this.data.fileCount === 1 ? 'file' : 'files'}: `) +
      currentTheme.fg('diffAdded', `+${String(this.data.additions)}`) +
      ' ' +
      currentTheme.fg('diffRemoved', `-${String(this.data.deletions)}`) +
      dot +
      currentTheme.boldFg('text', `${String(active.length)} ${active.length === 1 ? 'finding' : 'findings'}`);
    if (critical > 0) header += dot + currentTheme.boldFg('error', `${String(critical)} critical`);
    if (rejectedCount > 0) header += dot + currentTheme.fg('textDim', `${String(rejectedCount)} rejected`);
    return header;
  }
}

function commentLine(comment: ReviewSummaryComment, rejected: boolean): string {
  const location = `${comment.path}:${String(comment.line)}`;
  if (rejected) {
    return currentTheme.fg('textDim', `• ${location} — ${comment.title}`);
  }
  return (
    currentTheme.fg('textDim', `• ${location}`) + currentTheme.fg('text', ` — ${comment.title}`)
  );
}
