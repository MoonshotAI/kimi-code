/**
 * ReviewReaderFullscreenApp — full-screen alt-screen reader for a review.
 *
 * Mounted via container swap (like TasksBrowserApp): the host saves the UI
 * children, clears, and adds this as the sole child. Two columns: a comment
 * list on the left and the selected comment's detail + diff on the right.
 * Shares the comment/diff rendering helpers with the drawer reader.
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

import { currentTheme } from '#/tui/theme';
import { printableChar } from '@/tui/utils/printable-key';
import {
  clampIndex,
  renderCommentDiff,
  renderMarkdownLines,
  SEVERITY_TAG,
  severityColor,
  wrap,
} from './review-reader';

const MIN_WIDTH = 60;
const MIN_HEIGHT = 8;
const LIST_RATIO = 0.34;
const LIST_MIN = 26;
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
      return;
    }
    if (matchesKey(data, Key.up) || char === 'k') {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down) || char === 'j') {
      this.move(1);
      return;
    }
    if (char === 'x' || char === 'u') {
      this.toggleReject();
    }
  }

  private get comments(): readonly ReviewArtifactComment[] {
    return this.artifact.comments;
  }

  private move(delta: number): void {
    const count = this.comments.length;
    if (count === 0) return;
    this.index = (this.index + delta + count) % count;
    this.flash = undefined;
    this.props.requestRender();
  }

  private toggleReject(): void {
    const comment = this.comments[this.index];
    if (comment === undefined) return;
    const rejected = comment.state === 'dismissed';
    const action = rejected ? this.props.onRestore(comment.id) : this.props.onReject(comment.id);
    this.flash = rejected ? 'Restored.' : 'Rejected.';
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
    const bodyHeight = rows - 2;
    const listWidth = Math.max(LIST_MIN, Math.min(LIST_MAX, Math.floor(width * LIST_RATIO)));
    const rightWidth = width - listWidth - 1;

    const listColumn = this.renderList(listWidth, bodyHeight);
    const detailColumn = this.renderDetail(rightWidth, bodyHeight);
    const divider = currentTheme.fg('border', '│');

    const lines = [this.renderHeader(width)];
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(cell(listColumn[i] ?? '', listWidth) + divider + cell(detailColumn[i] ?? '', rightWidth));
    }
    lines.push(this.renderFooter(width));
    return lines;
  }

  private renderHeader(width: number): string {
    const total = this.comments.length;
    const label =
      currentTheme.boldFg('primary', ` Review ${this.artifact.slug}`) +
      currentTheme.fg('textDim', ` · ${String(total)} ${total === 1 ? 'comment' : 'comments'}`);
    return cell(label, width);
  }

  private renderFooter(width: number): string {
    const hint = '↑/↓ comment · x reject · u restore · q close';
    const flash = this.flash === undefined ? '' : currentTheme.fg('success', `  ${this.flash}`);
    return cell(currentTheme.fg('primary', ` ${hint}`) + flash, width);
  }

  private renderList(width: number, height: number): string[] {
    const comments = this.comments;
    if (comments.length === 0) return [currentTheme.fg('textMuted', ' No comments.')];
    const start = scrollStart(this.index, comments.length, height);
    const out: string[] = [];
    for (let i = start; i < Math.min(comments.length, start + height); i++) {
      const comment = comments[i]!;
      const selected = i === this.index;
      const pointer = selected ? currentTheme.boldFg('primary', '❯ ') : '  ';
      const rejected = comment.state === 'dismissed';
      const mark = severityColor(comment.severity)(SEVERITY_TAG[comment.severity]);
      const titleColor: Parameters<typeof currentTheme.fg>[0] = rejected ? 'textDim' : 'text';
      const title = currentTheme.fg(titleColor, comment.title);
      out.push(`${pointer}${mark}  ${title}`);
    }
    return out;
  }

  private renderDetail(width: number, height: number): string[] {
    const comment = this.comments[this.index];
    if (comment === undefined) return [];
    const inner = Math.max(10, width - 1);
    const detail: string[] = [];
    const rejected = comment.state === 'dismissed';
    detail.push(
      ' ' +
        severityColor(comment.severity)(SEVERITY_TAG[comment.severity]) +
        (rejected ? currentTheme.fg('warning', '  (rejected)') : ''),
    );
    detail.push(` ${currentTheme.fg('textDim', `${comment.anchor.path}:${String(comment.anchor.line)}`)}`);
    for (const line of wrap(comment.title, inner)) detail.push(` ${currentTheme.boldFg('textStrong', line)}`);
    detail.push('');
    for (const line of renderMarkdownLines(comment.body, inner)) detail.push(` ${line}`);
    if (comment.suggestedFix !== undefined && comment.suggestedFix.length > 0) {
      detail.push('');
      detail.push(currentTheme.boldFg('accent', ' Suggested fix'));
      for (const line of renderMarkdownLines(comment.suggestedFix, inner)) detail.push(` ${line}`);
    }
    detail.push('');
    detail.push(...renderCommentDiff(this.artifact.diff, comment, width));
    return detail.slice(0, height);
  }
}

/** Truncate `line` to `width` columns then pad with spaces to exactly `width`. */
function cell(line: string, width: number): string {
  const truncated = truncateToWidth(line, width, '…');
  return truncated + ' '.repeat(Math.max(0, width - visibleWidth(truncated)));
}

/** First visible index so the selected row stays centered within `height`. */
function scrollStart(index: number, length: number, height: number): number {
  if (length <= height) return 0;
  const half = Math.floor(height / 2);
  return Math.min(Math.max(0, index - half), length - height);
}
