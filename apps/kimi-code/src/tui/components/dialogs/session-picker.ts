import {
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import { formatSessionLabel } from '#/migration/index';
import { DockSection, type DockLayout, type DockPart } from '#/tui/components/chrome/dock-section';
import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import {
  focusOnUnfocusedMouse,
  handleSelectableListMouse,
  type MouseRowRegion,
} from '#/tui/utils/dialog-mouse';
import { printableChar } from '#/tui/utils/printable-key';
import { formatRelativeTime } from '#/tui/utils/relative-time';
import { SearchableList } from '#/tui/utils/searchable-list';
import { SpinnerTicker } from '#/tui/utils/spinner-ticker';
import { layoutTabStrip, type TabStripHitRange } from '#/tui/utils/tab-strip';
import { isSettlingClick } from '#/tui/utils/terminal-focus';
import { abbreviateHome } from '#/utils/paths';

export type SessionsScope = 'cwd' | 'project' | 'all';

export interface SessionRow {
  readonly id: string;
  readonly title: string | null;
  readonly last_prompt?: string | null;
  readonly work_dir: string;
  readonly project_work_dir?: string;
  readonly worktree?: string;
  readonly missing?: boolean;
  readonly updated_at: number;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

const ELLIPSIS = '…';
const SESSION_TABS: readonly { readonly scope: SessionsScope; readonly label: string }[] = [
  { scope: 'cwd', label: 'Cwd' },
  { scope: 'project', label: 'Project' },
  { scope: 'all', label: 'All' },
];

export function truncatePathLeft(path: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (visibleWidth(path) <= maxWidth) return path;
  if (maxWidth === 1) return ELLIPSIS;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const segments = [...segmenter.segment(path)].map((s) => s.segment);
  let used = 0;
  const budget = maxWidth - 1;
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

export class SessionPickerComponent extends DockSection implements Focusable {
  private sessions: SessionRow[];
  private currentSessionId: string;
  private onSelect: (session: SessionRow) => void | Promise<void>;
  private onCancel: () => void;
  private onToggleScope?: (selectedSessionId: string) => void;
  private onSelectScope?: (scope: SessionsScope, selectedSessionId: string) => void;
  private requestRender?: () => void;
  private maxVisibleSessions: number;
  private pageSize: number;
  private visibleCount: number;
  private scope: SessionsScope;
  private readonly showTabs: boolean;
  private loading: boolean;
  private hasMore: boolean;
  private loadingMore: boolean;
  private list: SearchableList<SessionRow>;
  private deleteState?: { session: SessionRow; phase: 'confirm' | 'deleting' };
  private selectInFlight = false;
  private readonly shownAt = Date.now();
  private cardRegions: readonly MouseRowRegion[] = [];
  private tabStripRow: number | undefined;
  private tabHitRanges: readonly TabStripHitRange[] = [];
  private lastVisibleRange: { readonly start: number; readonly count: number } = { start: 0, count: 0 };
  private readonly spinner = new SpinnerTicker(() => {
    this.invalidate();
    this.requestRender?.();
  });

  focused = false;

  constructor(opts: {
    sessions: SessionRow[];
    loading: boolean;
    currentSessionId: string;
    scope?: SessionsScope;
    showTabs?: boolean;
    layout?: DockLayout;
    initialSelectedSessionId?: string;
    pageSize?: number;
    onSelect: (session: SessionRow) => void | Promise<void>;
    onCancel: () => void;
    onCtrlC?: () => void;
    onCtrlD?: () => void;
    onToggleScope?: (selectedSessionId: string) => void;
    onSelectScope?: (scope: SessionsScope, selectedSessionId: string) => void;
    requestRender?: () => void;
    maxVisibleSessions?: number;
    hasMore?: boolean;
    loadingMore?: boolean;
    onLoadMore?: () => void;
    onSearchDrain?: () => void;
    onDeleteRequest?: (session: SessionRow) => Promise<void>;
  }) {
    super(opts.layout);
    this.sessions = opts.sessions;
    this.loading = opts.loading;
    this.currentSessionId = opts.currentSessionId;
    this.scope = opts.scope ?? 'cwd';
    this.showTabs = opts.showTabs === true;
    this.onSelect = opts.onSelect;
    this.onCancel = opts.onCancel;
    this.onToggleScope = opts.onToggleScope;
    this.onSelectScope = opts.onSelectScope;
    this.requestRender = opts.requestRender;
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

  appendSessions(rows: SessionRow[]): void {
    this.sessions = [...this.sessions, ...rows];
    this.list.setItems(this.sessions);
    const filteredCount = this.list.view().items.length;
    this.visibleCount =
      this.layout === undefined
        ? Math.max(this.visibleCount, Math.min(filteredCount, this.pageSize))
        : filteredCount;
  }

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
      this.scrollBodyToTop();
      if (view.query.length > 0 && previousQuery.length === 0 && this.hasMore) {
        this.onSearchDrain?.();
      }
      return;
    }

    const loadedCount = Math.min(view.items.length, this.visibleCount);
    if (view.selectedIndex >= loadedCount - 1 && loadedCount < view.items.length) {
      this.visibleCount = Math.min(view.items.length, this.visibleCount + this.pageSize);
    }
    if (
      this.hasMore &&
      !this.loadingMore &&
      view.items.length > 0 &&
      view.selectedIndex >= view.items.length - 1
    ) {
      this.onLoadMore?.();
    }
  }

  private switchScope(scope: SessionsScope): void {
    if (scope === this.scope) return;
    const selectedId = this.list.selected()?.id ?? this.currentSessionId;
    if (this.onSelectScope !== undefined) {
      this.onSelectScope(scope, selectedId);
    } else {
      this.onToggleScope?.(selectedId);
    }
  }

  private cycleTab(delta: -1 | 1): void {
    const currentIndex = SESSION_TABS.findIndex((tab) => tab.scope === this.scope);
    const nextIndex = (Math.max(0, currentIndex) + delta + SESSION_TABS.length) % SESSION_TABS.length;
    const nextTab = SESSION_TABS[nextIndex];
    if (nextTab !== undefined) this.switchScope(nextTab.scope);
  }

  handleInput(data: string): void {
    if (this.deleteState !== undefined) {
      this.handleDeleteInput(data);
      return;
    }
    if (this.selectInFlight) return;
    if (matchesKey(data, Key.ctrl('c'))) {
      this.onCtrlC?.();
      return;
    }
    if (matchesKey(data, Key.ctrl('d'))) {
      this.onCtrlD?.();
      return;
    }
    if (this.showTabs && matchesKey(data, Key.tab)) {
      this.cycleTab(1);
      return;
    }
    if (this.showTabs && matchesKey(data, Key.shift('tab'))) {
      this.cycleTab(-1);
      return;
    }
    if (matchesKey(data, Key.ctrl('a'))) {
      const selectedId = this.list.selected()?.id ?? this.currentSessionId;
      if (this.onSelectScope !== undefined) {
        this.onSelectScope(this.scope === 'all' ? 'cwd' : 'all', selectedId);
      } else {
        this.onToggleScope?.(selectedId);
      }
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
        this.scrollBodyToTop();
        return;
      }
      this.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const session = this.list.selected();
      if (session !== undefined) this.triggerSelect(session);
      return;
    }

    const previousQuery = this.list.view().query;
    if (this.list.handleKey(data)) {
      this.syncVisibleCount(previousQuery);
      this.ensureSelectedVisible();
    }
  }

  private triggerSelect(session: SessionRow): void {
    const selection = this.onSelect(session);
    if (selection === undefined) return;
    this.selectInFlight = true;
    this.spinner.start();
    this.invalidate();
    this.requestRender?.();
    const clear = (): void => {
      this.selectInFlight = false;
      this.spinner.stop();
      this.invalidate();
      this.requestRender?.();
    };
    void selection.then(clear, clear);
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

  dispose(): void {
    this.spinner.dispose();
  }

  protected override onBodyScrolled(): void {
    if (!this.isBodyScrolledNearEnd()) return;
    const filteredCount = this.list.view().items.length;
    if (this.visibleCount < filteredCount) {
      this.visibleCount = Math.min(filteredCount, this.visibleCount + this.pageSize);
      this.invalidate();
      this.requestRender?.();
    }
    if (this.hasMore && !this.loadingMore) {
      this.onLoadMore?.();
    }
  }

  protected override handlePartMouse(part: DockPart, event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.deleteState !== undefined || this.selectInFlight) return undefined;
    if (!this.focused) return focusOnUnfocusedMouse(event);
    if (part === 'head') {
      if (!this.showTabs || this.tabStripRow === undefined || event.y !== this.tabStripRow) return undefined;
      if (event.button !== 'left') return undefined;
      const hit = this.tabHitRanges.find((range) => event.x >= range.start && event.x < range.end);
      if (hit === undefined) return undefined;
      if (event.type === 'press') return { handled: true };
      if (event.type === 'click' && !isSettlingClick(this.shownAt)) {
        const target = SESSION_TABS[hit.index];
        if (target !== undefined) this.switchScope(target.scope);
        return { handled: true, render: true };
      }
      return undefined;
    }
    if (part !== 'body') return undefined;
    return handleSelectableListMouse({
      event,
      focused: this.focused,
      shownAt: this.shownAt,
      regions: this.cardRegions,
      select: (index) => this.selectIndex(index),
      activate: (index) => {
        const session = this.list.view().items[index];
        if (session !== undefined) this.triggerSelect(session);
      },
    });
  }

  private selectIndex(index: number): boolean {
    const changed = this.list.view().selectedIndex !== index;
    this.list.moveTo(index);
    return changed;
  }

  private ensureSelectedVisible(): void {
    if (this.layout === undefined) return;
    const selected = this.list.view().selectedIndex;
    const region = this.cardRegions.find((item) => item.index === selected);
    if (region !== undefined) {
      this.ensureBodyVisible(region.start, region.end);
    }
  }

  private scopeTitle(): string {
    if (this.scope === 'all') return 'All sessions';
    if (this.scope === 'project') return 'Project sessions';
    return 'Sessions';
  }

  private scopeHint(): string | undefined {
    if (this.onSelectScope === undefined && this.onToggleScope === undefined) return undefined;
    return this.scope === 'all' ? 'Ctrl+A current cwd' : 'Ctrl+A all';
  }

  protected override renderPart(part: DockPart, width: number): string[] {
    switch (part) {
      case 'head':
        return this.renderHead(width).map((line) => truncateToWidth(line, width, ELLIPSIS));
      case 'body':
        return this.renderBody(width).map((line) => truncateToWidth(line, width, ELLIPSIS));
      case 'foot':
        return this.renderFoot(width).map((line) => truncateToWidth(line, width, ELLIPSIS));
    }
  }

  private renderHead(width: number): string[] {
    const lines: string[] = [currentTheme.fg('primary', '─'.repeat(width))];
    const title = this.scopeTitle();
    const scopeHint = this.scopeHint();
    this.tabStripRow = undefined;
    this.tabHitRanges = [];

    if (this.loading) {
      lines.push(currentTheme.boldFg('primary', truncateToWidth(title, width, ELLIPSIS)));
      if (this.showTabs) this.pushTabStrip(lines, width);
      return lines;
    }

    if (this.sessions.length === 0) {
      const hintParts = [
        this.showTabs ? 'Tab switch' : undefined,
        scopeHint,
        'Esc cancel',
      ].filter((item): item is string => item !== undefined);
      lines.push(currentTheme.boldFg('primary', truncateToWidth(title, width, ELLIPSIS)));
      if (this.showTabs) this.pushTabStrip(lines, width);
      lines.push(currentTheme.fg('textMuted', truncateToWidth(hintParts.join(' · '), width, ELLIPSIS)));
      lines.push('');
      return lines;
    }

    const view = this.list.view();
    const titleSuffix =
      view.query.length === 0 ? currentTheme.fg('textMuted', '  (type to search)') : '';
    const hintParts = [
      ...(view.query.length > 0 ? ['Backspace clear'] : []),
      '↑↓ navigate',
      this.showTabs ? 'Tab switch' : undefined,
      scopeHint,
      ...(this.onDeleteRequest !== undefined ? ['Ctrl+X delete'] : []),
      'Enter select',
      'Esc cancel',
    ].filter((item): item is string => item !== undefined);

    lines.push(currentTheme.boldFg('primary', title) + titleSuffix);
    if (this.showTabs) this.pushTabStrip(lines, width);
    lines.push(currentTheme.fg('textMuted', hintParts.join(' · ')));
    if (this.selectInFlight) {
      lines.push(currentTheme.fg('textMuted', `${this.spinner.current} Resuming session…`));
    }
    lines.push('');

    if (view.query.length > 0) {
      lines.push(currentTheme.fg('primary', 'Search: ') + currentTheme.fg('text', view.query));
    }
    return lines;
  }

  private pushTabStrip(lines: string[], width: number): void {
    const activeIndex = Math.max(0, SESSION_TABS.findIndex((tab) => tab.scope === this.scope));
    const strip = layoutTabStrip({
      labels: SESSION_TABS.map((tab) => tab.label),
      activeIndex,
      width,
      colors: currentTheme.palette,
    });
    this.tabStripRow = lines.length;
    this.tabHitRanges = strip.hitRanges;
    lines.push(strip.line);
  }

  private renderBody(width: number): string[] {
    this.cardRegions = [];
    if (this.loading) {
      return [currentTheme.fg('textMuted', truncateToWidth('Loading sessions…', width, ELLIPSIS))];
    }
    if (this.sessions.length === 0) {
      return [currentTheme.fg('textMuted', truncateToWidth('No sessions found.', width, ELLIPSIS))];
    }

    const view = this.list.view();
    const loadedSessions = this.loadedSessions(view.items);
    if (loadedSessions.length === 0) {
      this.lastVisibleRange = { start: 0, count: 0 };
      return [currentTheme.fg('textMuted', truncateToWidth('No matches', width, ELLIPSIS))];
    }

    const selectedIndex = view.selectedIndex;
    const visibleStart =
      this.layout === undefined
        ? Math.max(
            0,
            Math.min(
              selectedIndex - Math.floor(this.maxVisibleSessions / 2),
              Math.max(0, loadedSessions.length - this.maxVisibleSessions),
            ),
          )
        : 0;
    const visibleSessions =
      this.layout === undefined
        ? loadedSessions.slice(visibleStart, visibleStart + this.maxVisibleSessions)
        : loadedSessions;
    this.lastVisibleRange = { start: visibleStart, count: visibleSessions.length };

    const lines: string[] = [];
    const regions: MouseRowRegion[] = [];
    for (const [vi, session] of visibleSessions.entries()) {
      const index = visibleStart + vi;
      const isSelected = index === selectedIndex;
      const isCurrent = session.id === this.currentSessionId;
      const start = lines.length;
      const card = this.renderSessionCard(width, session, isSelected, isCurrent);
      lines.push(...card);
      regions.push({ start, end: lines.length, index });
      if (vi < visibleSessions.length - 1) lines.push('');
    }
    this.cardRegions = regions;
    return lines;
  }

  private renderFoot(width: number): string[] {
    if (this.loading || this.sessions.length === 0) {
      return [currentTheme.fg('primary', '─'.repeat(width))];
    }
    const view = this.list.view();
    const loadedSessions = this.loadedSessions(view.items);
    if (loadedSessions.length === 0) {
      return [currentTheme.fg('primary', '─'.repeat(width))];
    }
    const lines: string[] = [];
    const filteredCount = view.items.length;
    const { start: visibleStart, count: visibleCount } = this.lastVisibleRange;
    if (
      loadedSessions.length > visibleCount ||
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
      const footer =
        this.layout !== undefined
          ? `${totalSuffix}${moreSuffix}`
          : `Showing ${String(visibleStart + 1)}-${String(visibleStart + visibleCount)} of ${totalSuffix}${moreSuffix}`;
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

    const trailingParts = [time, badge].filter((p) => p.length > 0);
    const trailingText = trailingParts.length > 0 ? '  ' + trailingParts.join('  ') : '';
    const trailingWidth = visibleWidth(trailingText);
    const headerPrefixWidth = visibleWidth(pointer) + 1;
    const titleBudget = Math.max(8, width - headerPrefixWidth - trailingWidth);
    const shownTitle = truncateToWidth(singleLine(titleSource), titleBudget, ELLIPSIS);

    let header = currentTheme.fg(isSelected ? 'primary' : 'textDim', pointer + ' ');
    header += titleStyle(shownTitle);
    if (time.length > 0) header += '  ' + currentTheme.fg('textDim', time);
    if (badge.length > 0) header += '  ' + currentTheme.fg('success', badge);
    const card: string[] = [header];

    const fullId = session.id;
    const idWidth = visibleWidth(fullId);
    const metaGap = '   ';
    const metaGapWidth = visibleWidth(metaGap);
    const idLineWidth = indentWidth + idWidth;
    const aliasedDir = abbreviateHome(session.work_dir);
    const dirWidth = visibleWidth(aliasedDir);
    const tags = [
      session.worktree === undefined ? '' : currentTheme.fg('accent', `worktree ${session.worktree}`),
      session.missing === true ? currentTheme.fg('warning', 'missing') : '',
    ].filter((tag) => tag.length > 0);
    const tagText = tags.length === 0 ? '' : metaGap + tags.join(' ');
    const tagWidth = visibleWidth(tagText);

    if (idLineWidth + metaGapWidth + dirWidth + tagWidth <= width) {
      card.push(
        indent +
          currentTheme.fg('textMuted', fullId) +
          currentTheme.fg('textDim', metaGap) +
          currentTheme.fg('textMuted', aliasedDir) +
          tagText,
      );
    } else {
      card.push(
        indent +
          currentTheme.fg(
            'textMuted',
            truncateToWidth(fullId, Math.max(idWidth, width - indentWidth), ELLIPSIS),
          ),
      );
      const dirBudget = Math.max(8, width - indentWidth - tagWidth);
      const dir = truncatePathLeft(aliasedDir, dirBudget);
      card.push(indent + currentTheme.fg('textMuted', dir) + tagText);
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
