import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import type { KimiWorktree } from '@moonshot-ai/kimi-code-sdk';

import { WORKTREE_SHORT_SHA_LENGTH } from '#/constant/worktree';
import {
  DockSection,
  finishDialogLines,
  type DockLayout,
  type DockPart,
} from '#/tui/components/chrome/dock-section';
import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme, type ColorToken } from '#/tui/theme';
import {
  focusOnUnfocusedMouse,
  handleSelectableListMouse,
  type MouseRowRegion,
} from '#/tui/utils/mouse-hit-test';
import { SearchableList } from '#/tui/utils/searchable-list';
import { abbreviateHome } from '#/utils/paths';

import { truncatePathLeft } from './session-picker';

export type WorktreePanelRow =
  | {
      readonly kind: 'source';
      readonly path: string;
      readonly branch?: string;
      readonly head?: string;
      readonly current: boolean;
    }
  | { readonly kind: 'worktree'; readonly worktree: KimiWorktree; readonly current: boolean };

export type WorktreeRow = Extract<WorktreePanelRow, { readonly kind: 'worktree' }>;

export interface WorktreePanelNotice {
  readonly text: string;
  readonly tone: ColorToken;
}

export interface WorktreePanelOptions {
  readonly repoName: string;
  readonly rows: readonly WorktreePanelRow[];
  readonly pageSize?: number;
  readonly layout?: DockLayout;
  readonly onOpen: (row: WorktreePanelRow) => void;
  readonly onNew: (initialName?: string) => void;
  readonly onDelete: (row: WorktreeRow) => void;
  readonly onCancel: () => void;
}

const HINT = '↑↓ navigate · Enter open · Ctrl+N new · Ctrl+X delete · Esc cancel';
const MISSING_NOTICE = "This worktree's directory is missing. Press Ctrl+X to remove the git record.";
const SOURCE_DELETE_NOTICE = "You can't delete the source checkout.";
const CURRENT_DELETE_NOTICE = "You're in this worktree. Leave it first, or exit Kimi Code to clean it up.";
const CURRENT_EXTERNAL_DELETE_NOTICE = "You're in this worktree. Switch to another checkout first.";
const MIN_NAME_WIDTH = 8;
const MAX_SUGGESTED_WORKTREE_NAME = 64;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/;

export function suggestWorktreeName(query: string): string | undefined {
  const sanitized = query
    .trim()
    .toLowerCase()
    .replaceAll(/[/\\\s]+/g, '-')
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/\.{2,}/g, '-')
    .replaceAll(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_SUGGESTED_WORKTREE_NAME)
    .replace(/[-.]+$/g, '');
  if (sanitized.length === 0 || WINDOWS_DEVICE_NAME.test(sanitized)) return undefined;
  return sanitized;
}

export class WorktreePanelComponent extends DockSection implements Focusable {
  focused = false;
  private readonly list: SearchableList<WorktreePanelRow>;
  private readonly shownAt = Date.now();
  private totalRows: number;
  private notice: WorktreePanelNotice | undefined;
  private rowRegions: readonly MouseRowRegion[] = [];
  private emptyCreateRow: MouseRowRegion | undefined;

  constructor(private readonly opts: WorktreePanelOptions) {
    super(opts.layout);
    this.totalRows = opts.rows.length;
    this.list = new SearchableList({
      items: opts.rows,
      toSearchText: (row) => rowSearchText(row, opts.repoName),
      pageSize: opts.layout === undefined ? opts.pageSize : opts.layout.maxBodyRows,
      initialIndex: Math.max(0, opts.rows.findIndex((row) => row.current)),
      searchable: true,
    });
  }

  setRows(rows: readonly WorktreePanelRow[]): void {
    this.totalRows = rows.length;
    this.list.setItems(rows);
  }

  setNotice(notice: WorktreePanelNotice | undefined): void {
    this.notice = notice;
  }

  handleInput(data: string): void {
    if (this.list.isPasting()) {
      const previousQuery = this.list.view().query;
      if (this.list.handleKey(data)) {
        this.notice = undefined;
        if (this.list.view().query !== previousQuery) this.scrollBodyToTop();
        this.ensureSelectedVisible();
      }
      return;
    }
    if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.list.clearQuery()) {
        this.notice = undefined;
        this.scrollBodyToTop();
        return;
      }
      this.opts.onCancel();
      return;
    }
    const row = this.list.selected();
    if (matchesKey(data, Key.enter)) {
      if (row !== undefined) {
        this.open(row);
      } else {
        this.opts.onNew(suggestWorktreeName(this.list.view().query));
      }
      return;
    }
    if (matchesKey(data, Key.ctrl('n'))) {
      this.opts.onNew(suggestWorktreeName(this.list.view().query));
      return;
    }
    if (matchesKey(data, Key.ctrl('x'))) {
      if (row !== undefined) this.delete(row);
      return;
    }
    const previousQuery = this.list.view().query;
    if (this.list.handleKey(data)) {
      this.notice = undefined;
      if (this.list.view().query !== previousQuery) this.scrollBodyToTop();
      this.ensureSelectedVisible();
    }
  }

  protected override renderPart(part: DockPart, width: number): string[] {
    switch (part) {
      case 'head':
        return this.finishLines(this.renderHead(width), width);
      case 'body':
        return this.finishLines(this.renderBody(width), width);
      case 'foot':
        return this.finishLines(this.renderFoot(width), width);
    }
  }

  protected override handlePartMouse(part: DockPart, event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.focused) return focusOnUnfocusedMouse(event);
    if (part !== 'body') return undefined;
    if (this.emptyCreateRow !== undefined) {
      return handleSelectableListMouse({
        event,
        focused: this.focused,
        shownAt: this.shownAt,
        regions: [this.emptyCreateRow],
        select: () => false,
        activate: () => {
          this.opts.onNew(suggestWorktreeName(this.list.view().query));
        },
      });
    }
    return handleSelectableListMouse({
      event,
      focused: this.focused,
      shownAt: this.shownAt,
      regions: this.rowRegions,
      select: (index) => this.selectIndex(index),
      activate: (index) => {
        const row = this.list.view().items[index];
        if (row !== undefined) this.open(row);
      },
    });
  }

  private renderHead(width: number): string[] {
    const view = this.list.view();
    const titleSuffix = view.query.length === 0 ? '  (type to search)' : '';
    const hint = view.query.length > 0 ? `Backspace clear · ${HINT}` : HINT;
    const lines = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Worktrees') +
        currentTheme.fg('textMuted', `  ${this.opts.repoName}${titleSuffix}`),
      currentTheme.fg('textMuted', ` ${hint}`),
    ];
    if (this.notice !== undefined) {
      for (const line of this.notice.text.split('\n')) {
        lines.push(currentTheme.fg(this.notice.tone, ` ${line}`));
      }
    }
    lines.push('');
    if (view.query.length > 0) {
      lines.push(currentTheme.fg('primary', ' Search: ') + currentTheme.fg('text', view.query));
    }
    return lines;
  }

  private renderBody(width: number): string[] {
    const view = this.list.view();
    const startIndex = this.layout === undefined ? view.page.start : 0;
    const rows = this.layout === undefined ? view.items.slice(view.page.start, view.page.end) : view.items;
    if (rows.length === 0) {
      this.rowRegions = [];
      const suggested = suggestWorktreeName(view.query);
      const heading = view.query.trim().length > 0 ? '  No matches' : '  No worktrees yet.';
      const cta = suggested === undefined ? '+ Create new worktree' : `+ Create "${suggested}"`;
      this.emptyCreateRow = { start: 2, end: 3, index: 0 };
      return [
        currentTheme.fg('textMuted', heading),
        '',
        currentTheme.fg('primary', `  ${SELECT_POINTER} `) +
          currentTheme.boldFg('primary', cta) +
          currentTheme.fg('textMuted', '  from HEAD'),
      ];
    }
    this.emptyCreateRow = undefined;
    const nameWidth = measureNameWidth(rows, this.opts.repoName, width);
    const regions: MouseRowRegion[] = [];
    const lines: string[] = [];
    rows.forEach((row, offset) => {
      const index = startIndex + offset;
      const start = lines.length;
      lines.push(renderRow(row, this.opts.repoName, index === view.selectedIndex, nameWidth));
      regions.push({ start, end: lines.length, index });
    });
    this.rowRegions = regions;
    return lines;
  }

  private renderFoot(width: number): string[] {
    const view = this.list.view();
    const lines = [''];
    const selected = view.items[view.selectedIndex];
    const count = this.counterText(view);
    if (selected !== undefined) {
      const rightPlain = count === '' ? '' : `${count} `;
      const rightWidth = visibleWidth(rightPlain);
      const leftBudget = Math.max(1, width - 1 - (rightWidth > 0 ? rightWidth + 2 : 1));
      const path = truncatePathLeft(abbreviateHome(rowPath(selected)), leftBudget);
      const leftStyled = ` ${currentTheme.fg('textMuted', path)}`;
      if (rightWidth === 0) {
        lines.push(leftStyled);
      } else {
        const gap = Math.max(1, width - (1 + visibleWidth(path)) - rightWidth);
        lines.push(`${leftStyled}${' '.repeat(gap)}${currentTheme.fg('textMuted', rightPlain)}`);
      }
    } else if (count !== '') {
      const rightPlain = `${count} `;
      const pad = Math.max(1, width - visibleWidth(rightPlain));
      lines.push(`${' '.repeat(pad)}${currentTheme.fg('textMuted', rightPlain)}`);
    }
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines;
  }

  private counterText(view: ReturnType<SearchableList<WorktreePanelRow>['view']>): string {
    if (view.query.length > 0) return `${String(view.items.length)} / ${String(this.totalRows)}`;
    if (this.layout === undefined) {
      const visibleCount = view.page.end - view.page.start;
      if (view.items.length > visibleCount) {
        return `${String(view.page.start + 1)}–${String(view.page.end)} / ${String(view.items.length)}`;
      }
      return '';
    }
    if (view.items.length > this.layout.maxBodyRows) {
      return `${String(view.selectedIndex + 1)} / ${String(view.items.length)}`;
    }
    return '';
  }

  private finishLines(lines: readonly string[], width: number): string[] {
    return finishDialogLines(lines, width, this.focused);
  }

  private selectIndex(index: number): boolean {
    const changed = this.list.view().selectedIndex !== index;
    if (changed) this.notice = undefined;
    this.list.moveTo(index);
    return changed;
  }

  private ensureSelectedVisible(): void {
    if (this.layout === undefined) return;
    const selected = this.list.view().selectedIndex;
    const region = this.rowRegions.find((item) => item.index === selected);
    if (region !== undefined) {
      this.ensureBodyVisible(region.start, region.end);
    } else {
      this.ensureBodyVisible(selected, selected + 1);
    }
  }

  private open(row: WorktreePanelRow): void {
    if (row.current) {
      this.opts.onCancel();
    } else if (row.kind === 'worktree' && row.worktree.missing) {
      this.notice = { text: MISSING_NOTICE, tone: 'warning' };
    } else {
      this.opts.onOpen(row);
    }
  }

  private delete(row: WorktreePanelRow): void {
    if (row.kind === 'source') {
      this.notice = { text: SOURCE_DELETE_NOTICE, tone: 'warning' };
    } else if (row.current) {
      this.notice = {
        text: row.worktree.managed ? CURRENT_DELETE_NOTICE : CURRENT_EXTERNAL_DELETE_NOTICE,
        tone: 'warning',
      };
    } else {
      this.opts.onDelete(row);
    }
  }
}

function rowName(row: WorktreePanelRow, repoName: string): string {
  return row.kind === 'source' ? repoName : row.worktree.name;
}

function rowPath(row: WorktreePanelRow): string {
  return row.kind === 'source' ? row.path : row.worktree.path;
}

function rowSearchText(row: WorktreePanelRow, repoName: string): string {
  if (row.kind === 'source') {
    const ref = row.branch ?? (row.head !== undefined && row.head.length > 0 ? 'detached' : '');
    return ref === ''
      ? `${repoName} ${abbreviateHome(row.path)} ${row.path}`
      : `${repoName} ${abbreviateHome(row.path)} ${row.path} ${ref}`;
  }
  const branch = row.worktree.branch ?? 'detached';
  const status = row.worktree.missing ? `missing ${branch}` : branch;
  return `${row.worktree.name} ${abbreviateHome(row.worktree.path)} ${row.worktree.path} ${status}`;
}

function measureNameWidth(rows: readonly WorktreePanelRow[], repoName: string, width: number): number {
  const cap = Math.max(MIN_NAME_WIDTH, Math.floor(width * 0.45));
  let measured = MIN_NAME_WIDTH;
  for (const row of rows) {
    const w = visibleWidth(rowName(row, repoName));
    if (w >= cap) return cap;
    if (w > measured) measured = w;
  }
  return measured;
}

function rowSideTag(row: WorktreePanelRow): { readonly text: string; readonly tone: ColorToken } | undefined {
  if (row.kind === 'worktree' && row.worktree.missing) return { text: 'missing', tone: 'warning' };
  const branch = row.kind === 'source' ? row.branch : row.worktree.branch;
  if (branch !== undefined) return { text: branch, tone: 'textMuted' };
  const head = row.kind === 'source' ? row.head : row.worktree.head;
  if (head !== undefined && head.length > 0) {
    return { text: `detached ${head.slice(0, WORKTREE_SHORT_SHA_LENGTH)}`, tone: 'textMuted' };
  }
  return undefined;
}

function renderRow(row: WorktreePanelRow, repoName: string, selected: boolean, nameWidth: number): string {
  const pointer = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${selected ? SELECT_POINTER : ' '} `);
  const name = truncateToWidth(rowName(row, repoName), nameWidth, '…');
  const label = selected ? currentTheme.boldFg('primary', name) : currentTheme.fg('text', name);
  const tag = rowSideTag(row);
  const side = tag === undefined ? '' : currentTheme.fg(tag.tone, tag.text);
  const current = row.current
    ? (side === '' ? '' : ' ') + currentTheme.fg('success', CURRENT_MARK)
    : '';
  const tail =
    side === '' && current === ''
      ? ''
      : `${' '.repeat(Math.max(0, nameWidth - visibleWidth(name)))}  ${side}${current}`;
  return pointer + label + tail;
}
