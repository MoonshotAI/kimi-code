/**
 * ReviewReaderComponent — interactive reader for a persisted review artifact.
 *
 * Mounted in the editor region via `mountEditorReplacement` (the same path
 * ChoicePicker uses). It shows one comment at a time: severity, title, body,
 * suggested fix, and a syntax-highlighted diff window anchored at the comment,
 * with a comment band under the anchored line. The user navigates between
 * comments and can reject / restore each one; rejections are persisted through
 * the `onReject` / `onRestore` callbacks and reflected live.
 */

import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import type { ReviewArtifact, ReviewArtifactComment } from '@moonshot-ai/kimi-code-sdk';

import { highlightLines, langFromPath } from '@/tui/components/media/code-highlight';
import { currentTheme } from '#/tui/theme';
import { buildDiffWindow, diffGutter, type DiffViewRow } from '@/tui/utils/review-diff';
import { printableChar } from '@/tui/utils/printable-key';

const SEVERITY_TAG: Record<ReviewArtifactComment['severity'], string> = {
  critical: '! critical',
  important: '! important',
  minor: '· minor',
};

export interface ReviewReaderProps {
  readonly artifact: ReviewArtifact;
  readonly onReject: (commentId: string) => Promise<ReviewArtifact | undefined>;
  readonly onRestore: (commentId: string) => Promise<ReviewArtifact | undefined>;
  readonly onClose: (artifact: ReviewArtifact) => void;
  readonly requestRender: () => void;
}

export class ReviewReaderComponent extends Container implements Focusable {
  focused = false;
  private artifact: ReviewArtifact;
  private index = 0;
  private flash: string | undefined;

  constructor(private readonly props: ReviewReaderProps) {
    super();
    this.artifact = props.artifact;
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
    const action = rejected
      ? this.props.onRestore(comment.id)
      : this.props.onReject(comment.id);
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
    const inner = Math.max(20, width);
    const lines: string[] = [currentTheme.fg('primary', '─'.repeat(inner))];
    const comment = this.comments[this.index];
    if (comment === undefined) {
      lines.push(currentTheme.fg('textMuted', ' No comments in this review.'));
      lines.push(this.statusBar());
      return lines;
    }

    const position = `comment ${String(this.index + 1)}/${String(this.comments.length)}`;
    const rejected = comment.state === 'dismissed';
    const tag = severityColor(comment.severity)(SEVERITY_TAG[comment.severity]);
    const rejectedTag = rejected ? currentTheme.fg('textMuted', '  (rejected)') : '';
    lines.push(
      currentTheme.boldFg('primary', ` Review ${String(this.artifact.id)}`) +
        currentTheme.fg('textMuted', ` · ${position} · `) +
        tag +
        rejectedTag,
    );
    lines.push(
      ` ${currentTheme.fg('text', `${comment.anchor.path}:${String(comment.anchor.line)}`)}  ` +
        currentTheme.boldFg('text', comment.title),
    );
    lines.push('');
    for (const line of wrap(comment.body, inner - 1)) lines.push(` ${currentTheme.fg('text', line)}`);
    if (comment.suggestedFix !== undefined && comment.suggestedFix.length > 0) {
      lines.push('');
      lines.push(currentTheme.boldFg('textMuted', ' Suggested fix'));
      for (const line of wrap(comment.suggestedFix, inner - 1)) {
        lines.push(` ${currentTheme.fg('textMuted', line)}`);
      }
    }

    lines.push('');
    lines.push(...this.renderDiff(comment, inner));
    lines.push(this.statusBar());
    return lines;
  }

  private renderDiff(comment: ReviewArtifactComment, inner: number): string[] {
    const window = buildDiffWindow(this.artifact.diff, comment.anchor, 3);
    if (window.rows.length === 0) {
      return [currentTheme.fg('textMuted', ' (no diff available for this comment)')];
    }
    const gutterWidth = 4;
    const code = window.rows.map((row) => row.text).join('\n');
    const highlighted = highlightLines(code, langFromPath(comment.anchor.path));
    const out: string[] = [];
    if (!window.found) {
      out.push(currentTheme.fg('textMuted', ' diff shifted since review — showing nearest hunk'));
    }
    window.rows.forEach((row, i) => {
      out.push(' ' + renderDiffRow(row, highlighted[i] ?? row.text, gutterWidth, inner));
      if (i === window.anchorIndex) {
        out.push(
          ' ' +
            currentTheme.boldFg('warning', '┃ ') +
            currentTheme.fg('warning', truncateToWidth(comment.title, Math.max(1, inner - 3), '…')),
        );
      }
    });
    return out;
  }

  private statusBar(): string {
    const hint = '↑/↓ move · x reject · u restore · q close';
    const flash = this.flash === undefined ? '' : currentTheme.fg('success', `  ${this.flash}`);
    return currentTheme.fg('textMuted', ` ${hint}`) + flash;
  }
}

function renderDiffRow(
  row: DiffViewRow,
  highlightedText: string,
  gutterWidth: number,
  inner: number,
): string {
  const gutter = diffGutter(row, gutterWidth);
  const gutterColor =
    row.kind === 'add' ? 'diffAdded' : row.kind === 'del' ? 'diffRemoved' : 'diffGutter';
  const available = Math.max(1, inner - visibleWidth(gutter) - 1);
  return currentTheme.fg(gutterColor, gutter) + ' ' + truncateToWidth(highlightedText, available, '…');
}

function severityColor(severity: ReviewArtifactComment['severity']): (text: string) => string {
  switch (severity) {
    case 'critical':
      return (text) => currentTheme.boldFg('error', text);
    case 'important':
      return (text) => currentTheme.boldFg('warning', text);
    case 'minor':
      return (text) => currentTheme.fg('textMuted', text);
  }
}

function wrap(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [];
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
