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
} from '@moonshot-ai/pi-tui';
import { formatSessionLabel } from '#/migration/index';
import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';

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

function sessionSearchText(session: SessionRow): string {
  return singleLine((session.title ?? session.id).trim() || session.id);
}

export class SessionPickerComponent extends Container implements Focusable {
  private sessions: SessionRow[];
  private currentSessionId: string;
  private onSelect: (session: SessionRow) => void | Promise<void>;
  private onCancel: () => void;
  private onToggleScope?: (selectedSessionId: string) => void;
  private maxVisibleSessions: number;
  private pageSize: number;
  private visibleCount: number;
  private scope: 'cwd' | 'all';
  private loading: boolean;
  private hasMore: boolean;
  private loadingMore: boolean;
  private list: SearchableList<SessionRow>;
  private deleteState?: { session: SessionRow; phase: 'confirm' | 'deleting' };
  private selectInFlight = false;

  focused = false;

  constructor(opts: {
    sessions: SessionRow[];
    loading: boolean;
    currentSessionId: string;
    scope?: 'cwd' | 'all';
    initialSelectedSessionId?: string;
    pageSize?: number;
    onSelect: (session: SessionRow) => void | Promise<void>;
    onCancel: () => void;
    onCtrlC?: () => void;
    onCtrlD?: () => void;
    onToggleScope?: (selectedSessionId: string) => void;
    maxVisibleSessions?: number;
    /** More pages exist on the backend (keyset paging). */
    hasMore?: boolean;
    /** A follow-up page fetch is in flight. */
    loadingMore?: boolean;
    /** Fired when the cursor reaches the end of every row fetched so far. */
    onLoadMore?: () => void;
    /** Fired when a search query becomes active while pages remain unfetched. */
    onSearchDrain?: () => void;
    /** Fired after the user confirms deletion with `y`; the picker clears its delete state once the request settles. */
    onDeleteRequest?: (session: SessionRow) => Promise<void>;
  }) {
    super();
    this.sessions = opts.sessions;
    this.loading = opts.loading;
    this.currentSessionId = opts.currentSessionId;
    this.scope = opts.scope ?? 'cwd';
    this.onSelect = opts.onSelect;
    this.onCancel = opts.onCancel;
    this.onToggleScope = opts.onToggleScope;
    this.maxVisibleSessions = opts.maxVisibleSessions ?? 4;
    this.pageSize = Math.max(1, opts.pageSize ?? 50);
    this.hasMore = opts.hasMore ?? false;
    this.loadingMore = opts.loadingMore ?? false;
    this.onLoadMore = opts.onLoadMore;
    this.onSearchDrain = opts.onSearchDrain;
    const initialIndex = this.resolveInitialSelectedIndex(opts.initialSelectedSessionId);
    this.list = new SearchableList({
      items: this.sessions,
      toSearchText: sessionSearchText,
      pageSize: this.pageSize,
      initialIndex,
      searchable: true,
    });
    const initialLoadedPages = Math.ceil((initialIndex + 1) / this.pageSize);
    this.visibleCount = Math.min(this.sessions.length, initialLoadedPages * this.pageSize);
    this.onCtrlC = opts.onCtrlC;
    this.onCtrlD = opts.onCtrlD;
    this.onDeleteRequest = opts.onDeleteRequest;
  }

  private readonly onCtrlC?: () => void;
  private readonly onCtrlD?: () => void;
  private readonly onLoadMore?: () => void;
  private readonly onSearchDrain?: () => void;
  private readonly onDeleteRequest?: (session: SessionRow) => Promise<void>;

  /** Appends a freshly fetched page, keeping the cursor and active query. */
  appendSessions(rows: SessionRow[]): void {
    this.sessions = [...this.sessions, ...rows];
    this.list.setItems(this.sessions);
    // Rows arriving while a query is active must become visible without
    // waiting for the next keypress; only grow, never shrink the window.
    this.visibleCount = Math.max(
      this.visibleCount,
      Math.min(this.list.view().items.length, this.pageSize),
    );
  }

  /** Updates the backend-paging facts after an in-flight fetch settles. */
  setPaging(hasMore: boolean, loadingMore: boolean): void {
    this.hasMore = hasMore;
    this.loadingMore = loadingMore;
  }

  private resolveInitialSelectedIndex(initialSelectedSessionId: string | undefined): number {
    if (initialSelectedSessionId === undefined) return 0;
    const index = this.sessions.findIndex((session) => session.id === initialSelectedSessionId);
    return Math.max(index, 0);
  }

  private filteredSessions(): readonly SessionRow[] {
    return this.list.view().items;
  }

  private loadedSessions(sessions: readonly SessionRow[] = this.filteredSessions()): SessionRow[] {
    return sessions.slice(0, Math.min(sessions.length, this.visibleCount));
  }

  private syncVisibleCount(previousQuery: string): void {
    const view = this.list.view();
    if (view.query !== previousQuery) {
      this.visibleCount = Math.min(view.items.length, this.pageSize);
      // A fresh query only searches the pages fetched so far; ask the host to
      // drain the rest in the background so search covers every session.
      if (view.query.length > 0 && previousQuery.length === 0 && this.hasMore) {
        this.onSearchDrain?.();
      }
      return;
    }

    const loadedCount = Math.min(view.items.length, this.visibleCount);
    if (view.selectedIndex >= loadedCount - 1 && loadedCount < view.items.length) {
      this.visibleCount = Math.min(view.items.length, this.visibleCount + this.pageSize);
    }
    // The cursor reached the end of everything fetched: pull the next page.
    if (
      this.hasMore &&
      !this.loadingMore &&
      view.items.length > 0 &&
      view.selectedIndex >= view.items.length - 1
    ) {
      this.onLoadMore?.();
    }
  }

  handleInput(data: string): void {
    if (this.deleteState !== undefined) {
      this.handleDeleteInput(data);
      return;
    }
    // A selection runs resume/switch asynchronously; input during that window
    // (e.g. Ctrl+X delete) would race the session swap.
    if (this.selectInFlight) return;
    if (matchesKey(data, Key.ctrl('c'))) {
      this.onCtrlC?.();
      return;
    }
    if (matchesKey(data, Key.ctrl('d'))) {
      this.onCtrlD?.();
      return;
    }
    if (matchesKey(data, Key.ctrl('a'))) {
      this.onToggleScope?.(this.list.selected()?.id ?? this.currentSessionId);
      return;
    }
    if (matchesKey(data, Key.ctrl('x'))) {
      const selected = this.list.selected();
      if (selected !== undefined && this.onDeleteRequest !== undefined) {
        this.deleteState = { session: selected, phase: 'confirm' };
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) {
        this.visibleCount = Math.min(this.filteredSessions().length, this.pageSize);
        return;
      }
      this.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const session = this.list.selected();
      if (session) {
        const selection = this.onSelect(session);
        if (selection !== undefined) {
          this.selectInFlight = true;
          const clear = (): void => {
            this.selectInFlight = false;
          };
          void selection.then(clear, clear);
        }
      }
      return;
    }

    const previousQuery = this.list.view().query;
    if (this.list.handleKey(data)) {
      this.syncVisibleCount(previousQuery);
    }
  }

  private handleDeleteInput(data: string): void {
    const state = this.deleteState;
    if (state === undefined || state.phase === 'deleting') return;
    const k = printableChar(data);
    if (matchesKey(data, Key.escape) || k === 'n' || k === 'N') {
      this.deleteState = undefined;
      this.invalidate();
      return;
    }
    if (k === 'y' || k === 'Y') {
      this.deleteState = { session: state.session, phase: 'deleting' };
      this.invalidate();
      const sessionId = state.session.id;
      const clear = (): void => {
        if (this.deleteState?.session.id !== sessionId) return;
        this.deleteState = undefined;
        this.invalidate();
      };
      // then(clear, clear): rejections settle too — the host has already surfaced the failure.
      void this.onDeleteRequest?.(state.session).then(clear, clear);
    }
  }

  private renderDeleteStateLine(width: number): string {
    const state = this.deleteState;
    if (state === undefined) return '';
    const rawTitle = (state.session.title ?? state.session.id).trim() || state.session.id;
    const label = singleLine(
      formatSessionLabel({ title: rawTitle, metadata: state.session.metadata }),
    );
    const prefix = state.phase === 'confirm' ? 'Delete session "' : 'Deleting session "';
    const suffix = state.phase === 'confirm' ? '"? [y/N]' : '"…';
    const labelBudget = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
    const shown = truncateToWidth(label, labelBudget, ELLIPSIS);
    // The suffix carries the confirm/cancel keys: it survives by truncating
    // the head (prefix + label) instead of the composed line.
    const head = truncateToWidth(
      prefix + shown,
      Math.max(0, width - visibleWidth(suffix)),
      ELLIPSIS,
    );
    const styled =
      state.phase === 'confirm'
        ? currentTheme.boldFg('warning', head + suffix)
        : currentTheme.fg('textMuted', head + suffix);
    return truncateToWidth(styled, width, ELLIPSIS);
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
    const lines: string[] = [currentTheme.fg('primary', '─'.repeat(width))];
    const title = this.scope === 'all' ? 'All sessions' : 'Sessions';
    const scopeHint =
      this.onToggleScope === undefined
        ? undefined
        : this.scope === 'all'
          ? 'Ctrl+A current cwd'
          : 'Ctrl+A all';

    if (this.loading) {
      lines.push(currentTheme.boldFg('primary', truncateToWidth(title, width, ELLIPSIS)));
      lines.push(
        currentTheme.fg('textMuted', truncateToWidth('Loading sessions…', width, ELLIPSIS)),
      );
      lines.push(currentTheme.fg('primary', '─'.repeat(width)));
      return lines;
    }

    if (this.sessions.length === 0) {
      const hintParts = [scopeHint, 'Esc cancel'].filter(
        (item): item is string => item !== undefined,
      );
      lines.push(currentTheme.boldFg('primary', truncateToWidth(title, width, ELLIPSIS)));
      lines.push(
        currentTheme.fg('textMuted', truncateToWidth(hintParts.join(' · '), width, ELLIPSIS)),
      );
      lines.push('');
      lines.push(
        currentTheme.fg('textMuted', truncateToWidth('No sessions found.', width, ELLIPSIS)),
      );
      lines.push(currentTheme.fg('primary', '─'.repeat(width)));
      return lines;
    }

    const view = this.list.view();
    const titleSuffix =
      view.query.length === 0 ? currentTheme.fg('textMuted', '  (type to search)') : '';
    const hintParts = [
      ...(view.query.length > 0 ? ['Backspace clear'] : []),
      '↑↓ navigate',
      scopeHint,
      ...(this.onDeleteRequest !== undefined ? ['Ctrl+X delete'] : []),
      'Enter select',
      'Esc cancel',
    ].filter((item): item is string => item !== undefined);

    lines.push(currentTheme.boldFg('primary', title) + titleSuffix);
    lines.push(currentTheme.fg('textMuted', hintParts.join(' · ')));
    lines.push('');

    if (view.query.length > 0) {
      lines.push(currentTheme.fg('primary', 'Search: ') + currentTheme.fg('text', view.query));
    }

    const loadedSessions = this.loadedSessions(view.items);
    if (loadedSessions.length === 0) {
      lines.push(currentTheme.fg('textMuted', truncateToWidth('No matches', width, ELLIPSIS)));
      lines.push(currentTheme.fg('primary', '─'.repeat(width)));
      return lines;
    }
    const selectedIndex = view.selectedIndex;
    const visibleStart = Math.max(
      0,
      Math.min(
        selectedIndex - Math.floor(this.maxVisibleSessions / 2),
        Math.max(0, loadedSessions.length - this.maxVisibleSessions),
      ),
    );
    const visibleSessions = loadedSessions.slice(
      visibleStart,
      visibleStart + this.maxVisibleSessions,
    );

    for (const [vi, session] of visibleSessions.entries()) {
      const index = visibleStart + vi;
      const isSelected = index === selectedIndex;
      const isCurrent = session.id === this.currentSessionId;
      const card = this.renderSessionCard(width, session, isSelected, isCurrent);
      lines.push(...card);
      if (vi < visibleSessions.length - 1) lines.push('');
    }

    const filteredCount = view.items.length;
    if (
      loadedSessions.length > visibleSessions.length ||
      view.query.length > 0 ||
      this.hasMore ||
      this.loadingMore
    ) {
      lines.push('');
      const moreSuffix = this.loadingMore
        ? ' · loading more…'
        : this.hasMore
          ? view.query.length > 0
            ? ' · searching all…'
            : ' · scroll for more'
          : '';
      const totalSuffix =
        view.query.length > 0
          ? `${String(loadedSessions.length)} loaded / ${String(filteredCount)} matches`
          : this.hasMore || this.loadingMore
            ? `${String(loadedSessions.length)} loaded`
            : loadedSessions.length === this.sessions.length
              ? `${String(loadedSessions.length)} sessions`
              : `${String(loadedSessions.length)} loaded / ${String(this.sessions.length)} sessions`;
      const footer = `Showing ${String(visibleStart + 1)}-${String(visibleStart + visibleSessions.length)} of ${totalSuffix}${moreSuffix}`;
      lines.push(currentTheme.fg('textMuted', truncateToWidth(footer, width, ELLIPSIS)));
    }

    if (this.deleteState !== undefined) {
      lines.push('');
      lines.push(this.renderDeleteStateLine(width));
    }

    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines;
  }

  private renderSessionCard(
    width: number,
    session: SessionRow,
    isSelected: boolean,
    isCurrent: boolean,
  ): string[] {
    const pointer = isSelected ? SELECT_POINTER : ' ';
    const indent = '  ';
    const indentWidth = visibleWidth(indent);
    const titleColor: 'primary' | 'text' = isSelected ? 'primary' : 'text';
    const titleStyle = (text: string) =>
      isSelected ? currentTheme.boldFg(titleColor, text) : currentTheme.fg(titleColor, text);

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

    let header = currentTheme.fg(isSelected ? 'primary' : 'textDim', pointer + ' ');
    header += titleStyle(shownTitle);
    if (time.length > 0) header += '  ' + currentTheme.fg('textDim', time);
    if (badge.length > 0) header += '  ' + currentTheme.fg('success', badge);
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
          currentTheme.fg('textMuted', fullId) +
          currentTheme.fg('textDim', metaGap) +
          currentTheme.fg('textMuted', aliasedDir),
      );
    } else {
      // Not enough room for both on one line — keep the id intact and put the
      // directory on the next line (left-truncated only if it still doesn't fit).
      card.push(
        indent +
          currentTheme.fg(
            'textMuted',
            truncateToWidth(fullId, Math.max(idWidth, width - indentWidth), ELLIPSIS),
          ),
      );
      const dirBudget = Math.max(8, width - indentWidth);
      const dir = truncatePathLeft(aliasedDir, dirBudget);
      card.push(indent + currentTheme.fg('textMuted', dir));
    }

    const rawPrompt = session.last_prompt?.trim();
    if (rawPrompt && rawPrompt.length > 0) {
      const promptMarker = '› ';
      const promptMarkerWidth = visibleWidth(promptMarker);
      const promptBudget = Math.max(8, width - indentWidth - promptMarkerWidth);
      const promptText = truncateToWidth(singleLine(rawPrompt), promptBudget, ELLIPSIS);
      const promptLine = indent + currentTheme.fg('textDim', promptMarker + promptText);
      card.push(promptLine);
    }

    return card;
  }
}
