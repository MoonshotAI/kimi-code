/**
 * SessionPicker — pi-tui version of the session selection dialog.
 */

import {
  Container,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { formatSessionLabel } from '#/migration/index';
import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';

export interface SessionRow {
  readonly id: string;
  readonly title: string | null;
  readonly last_prompt?: string | null;
  readonly work_dir: string;
  readonly updated_at: number;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

const ELLIPSIS = '…';

function formatRelativeTime(ts: number): string {
  // SessionSummary timestamps come from filesystem stat `*timeMs`,
  // so they use the same millisecond unit as `Date.now()`.
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diffSec = Math.floor(Math.max(0, Date.now() - ts) / 1000);
  if (diffSec < 60) return 'just now';
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

function homeAlias(path: string): string {
  const home = process.env['HOME'] ?? '';
  if (home && path.startsWith(home)) return '~' + path.slice(home.length);
  return path;
}

// Truncates from the LEFT (keeps the tail), prefixing an ellipsis when clipped.
// Paths typically carry the relevant info near the end, so we drop the prefix.
function truncatePathLeft(path: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (visibleWidth(path) <= maxWidth) return path;
  if (maxWidth === 1) return ELLIPSIS;
  // Walk graphemes from the end accumulating width, keep the longest tail
  // whose width + ellipsis fits.
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const segments = [...segmenter.segment(path)].map((s) => s.segment);
  let used = 0;
  const budget = maxWidth - 1; // reserve 1 column for ellipsis
  let i = segments.length - 1;
  while (i >= 0) {
    const seg = segments[i];
    if (seg === undefined) break;
    const w = visibleWidth(seg);
    if (used + w > budget) break;
    used += w;
    i--;
  }
  return ELLIPSIS + segments.slice(i + 1).join('');
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

export class SessionPickerComponent extends Container implements Focusable {
  private sessions: SessionRow[];
  private currentSessionId: string;
  private colors: ColorPalette;
  private onSelect: (sessionId: string) => void;
  private onCancel: () => void;
  private maxVisibleSessions: number;
  private loading: boolean;

  focused = false;
  private selectedIndex = 0;

  constructor(opts: {
    sessions: SessionRow[];
    loading: boolean;
    currentSessionId: string;
    colors: ColorPalette;
    onSelect: (sessionId: string) => void;
    onCancel: () => void;
    maxVisibleSessions?: number;
  }) {
    super();
    this.sessions = opts.sessions;
    this.loading = opts.loading;
    this.currentSessionId = opts.currentSessionId;
    this.colors = opts.colors;
    this.onSelect = opts.onSelect;
    this.onCancel = opts.onCancel;
    this.maxVisibleSessions = opts.maxVisibleSessions ?? 4;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter) && this.sessions.length > 0) {
      const session = this.sessions[this.selectedIndex];
      if (session) this.onSelect(session.id);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.sessions.length - 1, this.selectedIndex + 1);
    }
  }

  override render(width: number): string[] {
    return this.renderLines(width).map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  // Builds the raw lines; `render()` applies a final width clamp so no line
  // can ever exceed the terminal width. The per-line budgets below keep the
  // layout tidy at normal widths, but on a very narrow terminal those budgets
  // floor at a minimum and the trailing time/badge are appended in full, so
  // the clamp in `render()` is what guarantees the renderer's invariant and
  // prevents the "Rendered line exceeds terminal width" crash (issue #240).
  private renderLines(width: number): string[] {
    const colors = this.colors;
    const lines: string[] = [chalk.hex(colors.primary)('─'.repeat(width))];

    if (this.loading) {
      lines.push(chalk.hex(colors.primary).bold(truncateToWidth('Sessions', width, ELLIPSIS)));
      lines.push(
        chalk.hex(colors.textMuted)(truncateToWidth('Loading sessions...', width, ELLIPSIS)),
      );
      lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
      return lines;
    }

    if (this.sessions.length === 0) {
      lines.push(chalk.hex(colors.primary).bold(truncateToWidth('Sessions', width, ELLIPSIS)));
      lines.push(
        chalk.hex(colors.textMuted)(
          truncateToWidth('No sessions found. Press Escape to close.', width, ELLIPSIS),
        ),
      );
      lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
      return lines;
    }

    const headerLabel = 'Sessions ';
    const headerHint = '↑↓ navigate · Enter select · Esc cancel';
    const labelWidth = visibleWidth(headerLabel);
    const hintBudget = Math.max(0, width - labelWidth);
    const shownHint = truncateToWidth(headerHint, hintBudget, ELLIPSIS);
    lines.push(
      chalk.hex(colors.primary).bold(headerLabel) + chalk.hex(colors.textMuted)(shownHint),
    );
    lines.push('');

    const visibleStart = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisibleSessions / 2),
        Math.max(0, this.sessions.length - this.maxVisibleSessions),
      ),
    );
    const visibleSessions = this.sessions.slice(
      visibleStart,
      visibleStart + this.maxVisibleSessions,
    );

    for (const [vi, session] of visibleSessions.entries()) {
      const index = visibleStart + vi;
      const isSelected = index === this.selectedIndex;
      const isCurrent = session.id === this.currentSessionId;
      const card = this.renderSessionCard(width, session, isSelected, isCurrent);
      lines.push(...card);
      if (vi < visibleSessions.length - 1) lines.push('');
    }

    if (this.sessions.length > visibleSessions.length) {
      lines.push('');
      const footer = `Showing ${String(visibleStart + 1)}-${String(visibleStart + visibleSessions.length)} of ${String(this.sessions.length)} sessions`;
      lines.push(chalk.hex(colors.textMuted)(truncateToWidth(footer, width, ELLIPSIS)));
    }

    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines;
  }

  private renderSessionCard(
    width: number,
    session: SessionRow,
    isSelected: boolean,
    isCurrent: boolean,
  ): string[] {
    const colors = this.colors;
    const pointer = isSelected ? SELECT_POINTER : ' ';
    const indent = '  ';
    const indentWidth = visibleWidth(indent);
    const titleColor = isSelected ? colors.primary : colors.text;
    const titleStyle = isSelected ? chalk.hex(titleColor).bold : chalk.hex(titleColor);

    const time = formatRelativeTime(session.updated_at);
    const badge = isCurrent ? CURRENT_MARK : '';
    const rawTitle = (session.title ?? session.id).trim() || session.id;
    const titleSource = formatSessionLabel({ title: rawTitle, metadata: session.metadata });

    // Inline trailing parts after the title: "<title>  <time>  ← current".
    const trailingParts = [time, badge].filter((p) => p.length > 0);
    const trailingText = trailingParts.length > 0 ? '  ' + trailingParts.join('  ') : '';
    const trailingWidth = visibleWidth(trailingText);
    const headerPrefixWidth = visibleWidth(pointer) + 1; // pointer + space
    const titleBudget = Math.max(8, width - headerPrefixWidth - trailingWidth);
    const shownTitle = truncateToWidth(singleLine(titleSource), titleBudget, ELLIPSIS);

    let header = chalk.hex(isSelected ? colors.primary : colors.textDim)(pointer + ' ');
    header += titleStyle(shownTitle);
    if (time.length > 0) header += '  ' + chalk.hex(colors.textDim)(time);
    if (badge.length > 0) header += '  ' + chalk.hex(colors.success)(badge);
    const card: string[] = [header];

    // Session id is rendered in full at normal widths (the final clamp in
    // `render()` truncates it only when the terminal is narrower than the id).
    // The directory wraps to its own line if it would push past the edge.
    const fullId = session.id;
    const idWidth = visibleWidth(fullId);
    const metaGap = '   ';
    const metaGapWidth = visibleWidth(metaGap);
    const idLineWidth = indentWidth + idWidth;
    const aliasedDir = homeAlias(session.work_dir);
    const dirWidth = visibleWidth(aliasedDir);

    if (idLineWidth + metaGapWidth + dirWidth <= width) {
      card.push(
        indent +
          chalk.hex(colors.textMuted)(fullId) +
          chalk.hex(colors.textDim)(metaGap) +
          chalk.hex(colors.textMuted)(aliasedDir),
      );
    } else {
      // Not enough room for both on one line — keep the id intact and put the
      // directory on the next line (left-truncated only if it still doesn't fit).
      card.push(
        indent +
          chalk.hex(colors.textMuted)(
            truncateToWidth(fullId, Math.max(idWidth, width - indentWidth), ELLIPSIS),
          ),
      );
      const dirBudget = Math.max(8, width - indentWidth);
      const dir = truncatePathLeft(aliasedDir, dirBudget);
      card.push(indent + chalk.hex(colors.textMuted)(dir));
    }

    const rawPrompt = session.last_prompt?.trim();
    if (rawPrompt && rawPrompt.length > 0) {
      const promptMarker = '› ';
      const promptMarkerWidth = visibleWidth(promptMarker);
      const promptBudget = Math.max(8, width - indentWidth - promptMarkerWidth);
      const promptText = truncateToWidth(singleLine(rawPrompt), promptBudget, ELLIPSIS);
      const promptLine = indent + chalk.hex(colors.textDim)(promptMarker + promptText);
      card.push(promptLine);
    }

    return card;
  }
}
