/**
 * ReviewReaderFullscreenApp — full-screen alt-screen reader for a review.
 *
 * Mounted via container swap (like TasksBrowserApp). Two columns under a header
 * rule, over a footer rule: a comment list on the left (full wrapped titles)
 * and the selected comment's full, scrollable file diff on the right, with the
 * comment rendered as a marker-aligned band at its anchor line.
 *
 * Keys: ↑/↓ move between comments (re-centering the diff on the anchor),
 * j/k scroll the diff, Space/b page, g/G jump, y keep / n reject, q close.
 */

import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
  type ProcessTerminal,
} from '@earendil-works/pi-tui';
import type { ReviewArtifact, ReviewArtifactComment } from '@moonshot-ai/kimi-code-sdk';

import { highlightLines, langFromPath } from '@/tui/components/media/code-highlight';
import { currentTheme, type ColorToken } from '#/tui/theme';
import { reviewTargetHeading } from '@/tui/utils/review-options';
import { buildFileDiff, type FileDiffRow } from '@/tui/utils/review-diff';
import { printableChar } from '@/tui/utils/printable-key';
import { clampIndex, SEVERITY_TAG, severityColor, wrap } from './review-reader';

const MIN_WIDTH = 60;
const MIN_HEIGHT = 8;
const LIST_RATIO = 0.36;
const LIST_MIN = 28;
const LIST_MAX = 48;

export interface ReviewReaderFullscreenProps {
  readonly artifact: ReviewArtifact;
  readonly initialIndex?: number;
  readonly terminal: ProcessTerminal;
  readonly onReject: (commentId: string) => Promise<ReviewArtifact | undefined>;
  readonly onRestore: (commentId: string) => Promise<ReviewArtifact | undefined>;
  readonly onClose: (artifact: ReviewArtifact) => void;
  readonly requestRender: () => void;
}

export class ReviewReaderFullscreenApp extends Container implements Focusable {
  focused = false;
  private artifact: ReviewArtifact;
  private index = 0;
  private scroll = 0;
  private recenter = true;
  private bodyHeight = 1;
  private flash: string | undefined;

  constructor(private readonly props: ReviewReaderFullscreenProps) {
    super();
    this.artifact = props.artifact;
    this.index = clampIndex(props.initialIndex ?? 0, this.artifact.comments.length);
  }

  handleInput(data: string): void {
    const char = printableChar(data);
    if (matchesKey(data, Key.escape) || char === 'q') {
      this.props.onClose(this.artifact);
    } else if (matchesKey(data, Key.up)) {
      this.moveComment(-1);
    } else if (matchesKey(data, Key.down)) {
      this.moveComment(1);
    } else if (char === 'k') {
      this.scrollDiff(-1);
    } else if (char === 'j') {
      this.scrollDiff(1);
    } else if (char === ' ') {
      this.scrollDiff(this.bodyHeight - 2);
    } else if (char === 'b') {
      this.scrollDiff(-(this.bodyHeight - 2));
    } else if (char === 'g') {
      this.setScroll(0);
    } else if (char === 'G') {
      this.setScroll(Number.MAX_SAFE_INTEGER);
    } else if (char === 'y') {
      this.verdict('keep');
    } else if (char === 'n') {
      this.verdict('reject');
    }
  }

  private get comments(): readonly ReviewArtifactComment[] {
    return this.artifact.comments;
  }

  private moveComment(delta: number): void {
    const count = this.comments.length;
    if (count === 0) return;
    this.index = (this.index + delta + count) % count;
    this.recenter = true;
    this.flash = undefined;
    this.props.requestRender();
  }

  private scrollDiff(delta: number): void {
    this.recenter = false;
    this.scroll = Math.max(0, this.scroll + delta);
    this.props.requestRender();
  }

  private setScroll(value: number): void {
    this.recenter = false;
    this.scroll = Math.max(0, value);
    this.props.requestRender();
  }

  private verdict(kind: 'keep' | 'reject'): void {
    const comment = this.comments[this.index];
    if (comment === undefined) return;
    const action = kind === 'keep' ? this.props.onRestore(comment.id) : this.props.onReject(comment.id);
    this.flash = kind === 'keep' ? 'Kept.' : 'Rejected.';
    this.props.requestRender();
    void action.then((updated) => {
      if (updated !== undefined) {
        this.artifact = updated;
        this.props.requestRender();
      }
    });
  }

  override render(width: number): string[] {
    const rows = Math.max(1, this.props.terminal.rows);
    if (width < MIN_WIDTH || rows < MIN_HEIGHT) {
      return [currentTheme.fg('textMuted', 'Terminal too small for the review reader. Press q to exit.')];
    }
    this.bodyHeight = rows - 4;
    const listWidth = Math.max(LIST_MIN, Math.min(LIST_MAX, Math.floor(width * LIST_RATIO)));
    const rightWidth = width - listWidth - 1;

    const listColumn = this.renderList(listWidth, this.bodyHeight);
    const diffColumn = this.renderDiff(rightWidth, this.bodyHeight);
    const divider = currentTheme.fg('border', '│');

    const lines = [this.renderHeader(width), this.rule(listWidth, rightWidth, '┬')];
    for (let i = 0; i < this.bodyHeight; i++) {
      lines.push(cell(listColumn[i] ?? '', listWidth) + divider + cell(diffColumn[i] ?? '', rightWidth));
    }
    lines.push(this.rule(listWidth, rightWidth, '┴'), this.renderFooter(width));
    return lines;
  }

  private rule(listWidth: number, rightWidth: number, joint: string): string {
    return currentTheme.fg('border', '─'.repeat(listWidth) + joint + '─'.repeat(rightWidth));
  }

  private renderHeader(width: number): string {
    const total = this.comments.length;
    const rejected = this.comments.filter((comment) => comment.state === 'dismissed').length;
    const counts = `${String(total)} ${total === 1 ? 'comment' : 'comments'}` +
      (rejected > 0 ? ` (${String(rejected)} rejected)` : '');
    const text = ` Review ${this.artifact.slug}  ·  ${reviewTargetHeading(this.artifact.target)}  ·  ${counts}`;
    return cell(currentTheme.boldFg('primary', text), width);
  }

  private renderFooter(width: number): string {
    const hint = '↑/↓ comment · j/k scroll · y keep · n reject · q close';
    const flash = this.flash === undefined ? '' : currentTheme.fg('success', `  ${this.flash}`);
    return cell(currentTheme.fg('primary', ` ${hint}`) + flash, width);
  }

  private renderList(width: number, height: number): string[] {
    const comments = this.comments;
    if (comments.length === 0) return [currentTheme.fg('textMuted', ' No comments.')];

    const lines: string[] = [];
    const blockStart: number[] = [];
    comments.forEach((comment, i) => {
      blockStart[i] = lines.length;
      const selected = i === this.index;
      const rejected = comment.state === 'dismissed';
      const pointer = selected ? currentTheme.boldFg('primary', '❯ ') : '  ';
      const tag = rejected
        ? currentTheme.fg('textDim', '⌫ rejected')
        : severityColor(comment.severity)(SEVERITY_TAG[comment.severity]);
      const loc = currentTheme.fg('textDim', truncateLeft(`${comment.anchor.path}:${String(comment.anchor.line)}`, width - 14));
      lines.push(`${pointer}${tag}  ${loc}`);
      const titleColor: ColorToken = rejected ? 'textDim' : 'text';
      for (const titleLine of wrap(comment.title, width - 2)) {
        lines.push('  ' + (selected ? currentTheme.boldFg(titleColor, titleLine) : currentTheme.fg(titleColor, titleLine)));
      }
      lines.push('');
    });

    const selStart = blockStart[this.index] ?? 0;
    const start = Math.min(Math.max(0, selStart - Math.floor(height / 3)), Math.max(0, lines.length - height));
    return lines.slice(start, start + height);
  }

  private renderDiff(width: number, height: number): string[] {
    const comment = this.comments[this.index];
    if (comment === undefined) return [];
    const view = buildFileDiff(this.artifact.diff, comment.anchor);
    if (view.rows.length === 0) {
      return [currentTheme.fg('textMuted', ' (no diff available for this comment)')];
    }

    const gutterWidth = view.lineNumberWidth;
    const codeRows = view.rows.filter((row) => row.kind !== 'hunk');
    const highlighted = highlightLines(codeRows.map((row) => row.text).join('\n'), langFromPath(comment.anchor.path));
    const highlightByRow = new Map<FileDiffRow, string>();
    codeRows.forEach((row, i) => highlightByRow.set(row, highlighted[i] ?? row.text));

    const band = renderBand(comment, gutterWidth, width);
    const display: string[] = [];
    let anchorDisplayIndex = 0;
    view.rows.forEach((row, i) => {
      display.push(renderDiffRow(row, highlightByRow.get(row) ?? row.text, gutterWidth, width));
      if (i === view.anchorIndex) {
        anchorDisplayIndex = display.length - 1;
        display.push(...band);
      }
    });

    const maxScroll = Math.max(0, display.length - height);
    if (this.recenter) {
      this.scroll = Math.min(Math.max(0, anchorDisplayIndex - Math.floor(height / 2)), maxScroll);
      this.recenter = false;
    } else {
      this.scroll = Math.min(this.scroll, maxScroll);
    }
    const windowed = display.slice(this.scroll, this.scroll + height);
    if (!view.found) {
      windowed[0] = currentTheme.fg('textMuted', ' (anchor not in diff — showing the file)');
    }
    return windowed;
  }
}

function renderDiffRow(row: FileDiffRow, highlightedText: string, gutterWidth: number, width: number): string {
  if (row.kind === 'hunk') {
    return ' ' + currentTheme.fg('diffMeta', truncateToWidth(row.text, Math.max(1, width - 1), '…'));
  }
  const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
  const number = row.kind === 'del' ? row.oldLine : row.newLine;
  const gutter = ` ${String(number ?? '').padStart(gutterWidth)} ${marker} `;
  const gutterColor: ColorToken = row.kind === 'add' ? 'diffAdded' : row.kind === 'del' ? 'diffRemoved' : 'diffGutter';
  const available = Math.max(1, width - visibleWidth(gutter));
  return currentTheme.fg(gutterColor, gutter) + truncateToWidth(highlightedText, available, '…');
}

/** The marker-aligned comment band: ┎ rule, ┃ lines, ┖ rule, indented to the +/- column. */
function renderBand(comment: ReviewArtifactComment, gutterWidth: number, width: number): string[] {
  const indent = ' '.repeat(gutterWidth + 2); // leading space + line number + space → marker column
  const inner = Math.max(8, width - indent.length - 2);
  const ruleWidth = Math.max(1, width - indent.length - 1);
  const heading = `! ${comment.severity} — ${comment.title}`;
  const body = comment.body.length > 0 ? wrap(comment.body, inner) : [];
  const tone: ColorToken = comment.severity === 'critical' ? 'error' : comment.severity === 'important' ? 'warning' : 'textDim';
  const bar = currentTheme.fg(tone, '┃');
  const lines = [indent + currentTheme.fg(tone, '┎' + '─'.repeat(ruleWidth))];
  for (const line of [heading, ...body]) {
    lines.push(indent + bar + ' ' + truncateToWidth(line, inner, '…'));
  }
  lines.push(indent + currentTheme.fg(tone, '┖' + '─'.repeat(ruleWidth)));
  return lines;
}

/** Truncate to `width` then pad with spaces to exactly `width`. */
function cell(line: string, width: number): string {
  const truncated = truncateToWidth(line, width, '…');
  return truncated + ' '.repeat(Math.max(0, width - visibleWidth(truncated)));
}

/** Truncate from the left, keeping the tail (so long paths keep file + line). */
function truncateLeft(text: string, width: number): string {
  if (width <= 1) return text.slice(-1);
  if (text.length <= width) return text;
  return '…' + text.slice(-(width - 1));
}
