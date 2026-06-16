/**
 * ReviewSummaryComponent — the compact, colored review block shown in the
 * transcript after a review completes (and re-rendered after reject in the
 * reader). Unlike the plain Markdown render it can color the bullet, the
 * diffstat, and the counts.
 */

import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme, type ColorToken } from '#/tui/theme';
import { abbreviatePath } from '#/tui/utils/abbreviate-path';
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

const SECTION_INDENT = '   '; // 3 cols
const ITEM_INDENT = '     '; // 5 cols — aligns under the "• " bullet text

export class ReviewSummaryComponent implements Component {
  constructor(private readonly data: ReviewSummaryTranscriptData) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (this.data.variant === 'browsed') return this.renderBrowsed(width);
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
      lines.push(SECTION_INDENT + currentTheme.boldFg(SEVERITY_COLOR[severity], SEVERITY_LABEL[severity]));
      for (const fileGroup of groupByFile(group)) {
        lines.push(...renderFileGroup(fileGroup, width));
      }
    }
    if (rejected.length > 0) {
      lines.push('');
      lines.push(SECTION_INDENT + currentTheme.boldFg('textDim', 'Rejected'));
      for (const comment of rejected) lines.push(SECTION_INDENT + rejectedLine(comment));
    }
    if (this.data.handle !== undefined) {
      lines.push('');
      lines.push(
        SECTION_INDENT +
          currentTheme.fg('textDim', 'Browse or reject: ') +
          currentTheme.fg('primary', `/review read ${this.data.handle}`),
      );
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderBrowsed(width: number): string[] {
    const rejected = this.data.comments.filter((comment) => comment.rejected);
    const heading =
      currentTheme.boldFg('success', `${STATUS_BULLET}Code review browsed`) +
      currentTheme.fg('textDim', rejected.length === 0
        ? ' · no comments rejected'
        : ` · ${String(rejected.length)} rejected`);
    const lines = ['', heading];
    for (const comment of rejected) {
      lines.push('   ' + currentTheme.fg('textDim', `• ${comment.path}:${String(comment.line)} — ${comment.title}`));
    }
    if (this.data.comments.length > 0) {
      // Breathe between the rejected list and the tip so it doesn't look cramped.
      if (rejected.length > 0) lines.push('');
      lines.push('  ' + currentTheme.dim('Tips: Ask Kimi to fix these comments, or discuss them here in chat.'));
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
      currentTheme.boldFg('text', `${String(active.length)} ${active.length === 1 ? 'review comment' : 'review comments'}`);
    if (critical > 0) header += dot + currentTheme.boldFg('error', `${String(critical)} critical`);
    if (rejectedCount > 0) header += dot + currentTheme.fg('textDim', `${String(rejectedCount)} rejected`);
    return header;
  }
}

/** Group a same-severity comment list by file, preserving first-seen order. */
function groupByFile(comments: readonly ReviewSummaryComment[]): ReviewSummaryComment[][] {
  const byPath = new Map<string, ReviewSummaryComment[]>();
  for (const comment of comments) {
    const bucket = byPath.get(comment.path);
    if (bucket === undefined) byPath.set(comment.path, [comment]);
    else bucket.push(comment);
  }
  return [...byPath.values()].map((bucket) => bucket.toSorted((a, b) => a.line - b.line));
}

/** Render one file's comments: inline when there's one, nested when there are several. */
function renderFileGroup(comments: readonly ReviewSummaryComment[], width: number): string[] {
  const first = comments[0];
  if (first === undefined) return [];
  if (comments.length === 1) return renderSingle(first, width);
  return renderNested(first.path, comments, width);
}

/**
 * One comment in a file. Kept on a single line when it fits; otherwise the
 * path:line moves to its own line (abbreviated if needed) and the title wraps
 * below it, so a long path can no longer truncate the title.
 */
function renderSingle(comment: ReviewSummaryComment, width: number): string[] {
  const location = `${comment.path}:${String(comment.line)}`;
  const oneLine = `${SECTION_INDENT}• ${location} — ${comment.title}`;
  if (visibleWidth(oneLine) <= width) {
    return [
      SECTION_INDENT +
        currentTheme.boldFg('textDim', `• ${location}`) +
        currentTheme.fg('text', ` — ${comment.title}`),
    ];
  }
  const lineSuffix = `:${String(comment.line)}`;
  const pathBudget = Math.max(1, width - SECTION_INDENT.length - 2 - visibleWidth(lineSuffix));
  const head = SECTION_INDENT + currentTheme.boldFg('textDim', `• ${abbreviatePath(comment.path, pathBudget)}${lineSuffix}`);
  const titleLines = wrapText(comment.title, Math.max(1, width - ITEM_INDENT.length)).map(
    (line) => ITEM_INDENT + currentTheme.fg('text', line),
  );
  return [head, ...titleLines];
}

/** Several comments in one file: a path header, then padded `Line N:  title` items. */
function renderNested(path: string, comments: readonly ReviewSummaryComment[], width: number): string[] {
  const pathBudget = Math.max(1, width - SECTION_INDENT.length - 2);
  const lines = [
    SECTION_INDENT + currentTheme.boldFg('textDim', `• ${abbreviatePath(path, pathBudget)}`),
  ];
  // Pad the `Line N:` tags to a common width so titles align across rows.
  const tags = comments.map((comment) => `Line ${String(comment.line)}:`);
  const tagWidth = Math.max(...tags.map((tag) => visibleWidth(tag)));
  comments.forEach((comment, index) => {
    const tag = (tags[index] ?? '').padEnd(tagWidth);
    const titleBudget = Math.max(1, width - ITEM_INDENT.length - tagWidth - 2);
    const wrapped = wrapText(comment.title, titleBudget);
    const continuation = ' '.repeat(tagWidth + 2);
    wrapped.forEach((line, i) => {
      const prefix = i === 0
        ? currentTheme.fg('textDim', `${tag}  `)
        : currentTheme.fg('textDim', continuation);
      lines.push(ITEM_INDENT + prefix + currentTheme.fg('text', line));
    });
  });
  return lines;
}

function rejectedLine(comment: ReviewSummaryComment): string {
  const location = `${comment.path}:${String(comment.line)}`;
  return currentTheme.fg('textDim', `• ${location} — ${comment.title}`);
}

/** Greedy word-wrap to `width` columns (measured visibly), never returning empty. */
function wrapText(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= max) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = visibleWidth(word) <= max ? word : truncateToWidth(word, max, '…');
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
