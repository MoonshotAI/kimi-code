import {
  Key,
  matchesKey,
  visibleWidth,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import type { KimiWorktree } from '@moonshot-ai/kimi-code-sdk';

import { WORKTREE_SHORT_SHA_LENGTH } from '#/constant/worktree';
import { DockSection, type DockLayout, type DockPart } from '#/tui/components/chrome/dock-section';
import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme, type ColorToken } from '#/tui/theme';
import {
  finishDialogLines,
  focusOnUnfocusedMouse,
  handleSelectableListMouse,
  type MouseRowRegion,
} from '#/tui/utils/dialog-mouse';
import { SearchableList } from '#/tui/utils/searchable-list';
import { abbreviateHome } from '#/utils/paths';

import { truncatePathLeft } from './session-picker';

export type WorktreePanelRow =
  | { readonly kind: 'source'; readonly path: string; readonly current: boolean }
  | { readonly kind: 'worktree'; readonly worktree: KimiWorktree; readonly current: boolean }
  | { readonly kind: 'new' };

export type WorktreePanelTarget = Exclude<WorktreePanelRow, { readonly kind: 'new' }>;
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
  readonly onOpen: (row: WorktreePanelTarget) => void;
  readonly onNew: () => void;
  readonly onDelete: (row: WorktreeRow) => void;
  readonly onCancel: () => void;
}

const HINT = '↑↓ navigate · Enter open · Ctrl+N new · Ctrl+X delete · Esc cancel';
const NEW_ROW_LABEL = '+ New worktree';
const MISSING_NOTICE = "This worktree's directory is missing. Delete it to clean up the git record.";
const SOURCE_DELETE_NOTICE = "You can't delete the source checkout.";
const CURRENT_DELETE_NOTICE = "You're in this worktree. Leave it first, or exit Kimi Code to clean it up.";
const CURRENT_EXTERNAL_DELETE_NOTICE = "You're in this worktree. Switch to another checkout first.";
const MIN_PATH_WIDTH = 12;

export class WorktreePanelComponent extends DockSection implements Focusable {
  focused = false;
  private readonly list: SearchableList<WorktreePanelRow>;
  private readonly shownAt = Date.now();
  private notice: WorktreePanelNotice | undefined;
  private rowRegions: readonly MouseRowRegion[] = [];

  constructor(private readonly opts: WorktreePanelOptions) {
    super(opts.layout);
    this.list = new SearchableList({
      items: opts.rows,
      toSearchText: rowSearchText,
      pageSize: opts.layout === undefined ? opts.pageSize : opts.layout.maxBodyRows,
      initialIndex: Math.max(0, opts.rows.findIndex((row) => row.kind !== 'new' && row.current)),
      searchable: true,
    });
  }

  setRows(rows: readonly WorktreePanelRow[]): void {
    this.list.setItems(rows);
  }

  setNotice(notice: WorktreePanelNotice | undefined): void {
    this.notice = notice;
  }

  handleInput(data: string): void {
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
      if (row !== undefined) this.open(row);
      return;
    }
    if (matchesKey(data, Key.ctrl('n'))) {
      this.opts.onNew();
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
      return [currentTheme.fg('textMuted', '  No matching worktrees.')];
    }
    const sideWidth = Math.max(0, ...rows.map((row) => visibleWidth(rowSidePlain(row))));
    const maxPathBudget = Math.max(MIN_PATH_WIDTH, width - 4 - (sideWidth > 0 ? sideWidth + 2 : 0));
    const pathWidth = Math.min(
      Math.max(0, ...rows.map((row) => (row.kind === 'new' ? 0 : visibleWidth(abbreviateHome(rowPath(row)))))),
      maxPathBudget,
    );
    const regions: MouseRowRegion[] = [];
    const lines: string[] = [];
    rows.forEach((row, offset) => {
      const index = startIndex + offset;
      const start = lines.length;
      lines.push(renderRow(row, index === view.selectedIndex, pathWidth));
      regions.push({ start, end: lines.length, index });
    });
    this.rowRegions = regions;
    return lines;
  }

  private renderFoot(width: number): string[] {
    const view = this.list.view();
    const lines = [''];
    if (this.layout === undefined) {
      const below = view.items.length - view.page.end;
      if (below > 0) lines.push(currentTheme.fg('textMuted', ` ▼ ${String(below)} more`));
    }
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines;
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
    if (row.kind === 'new') {
      this.opts.onNew();
    } else if (row.current) {
      this.opts.onCancel();
    } else if (row.kind === 'worktree' && row.worktree.missing) {
      this.notice = { text: MISSING_NOTICE, tone: 'warning' };
    } else {
      this.opts.onOpen(row);
    }
  }

  private delete(row: WorktreePanelRow): void {
    if (row.kind === 'new') return;
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

function rowSearchText(row: WorktreePanelRow): string {
  if (row.kind === 'new') return NEW_ROW_LABEL;
  if (row.kind === 'source') return `${abbreviateHome(row.path)} ${row.path} source`;
  const branch = row.worktree.branch ?? 'detached';
  return `${row.worktree.name} ${abbreviateHome(row.worktree.path)} ${row.worktree.path} ${branch}`;
}

function rowPath(row: WorktreePanelTarget): string {
  return row.kind === 'source' ? row.path : row.worktree.path;
}

function rowSideTag(row: WorktreePanelRow): { readonly text: string; readonly tone: ColorToken } | undefined {
  if (row.kind === 'new') return undefined;
  if (row.kind === 'source') return { text: 'source', tone: 'textMuted' };
  if (row.worktree.missing) return { text: 'missing', tone: 'warning' };
  if (row.worktree.branch !== undefined) return { text: row.worktree.branch, tone: 'textDim' };
  if (row.worktree.head !== undefined && row.worktree.head.length > 0) {
    return { text: `detached ${row.worktree.head.slice(0, WORKTREE_SHORT_SHA_LENGTH)}`, tone: 'textDim' };
  }
  return undefined;
}

function rowSidePlain(row: WorktreePanelRow): string {
  if (row.kind === 'new') return '';
  const tag = rowSideTag(row)?.text ?? '';
  const current = row.current ? (tag === '' ? CURRENT_MARK : ` ${CURRENT_MARK}`) : '';
  return tag + current;
}

function renderRow(row: WorktreePanelRow, selected: boolean, pathWidth: number): string {
  const pointer = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${selected ? SELECT_POINTER : ' '} `);
  if (row.kind === 'new') {
    return pointer + (selected ? currentTheme.boldFg('primary', NEW_ROW_LABEL) : currentTheme.fg('accent', NEW_ROW_LABEL));
  }
  const path = truncatePathLeft(abbreviateHome(rowPath(row)), pathWidth);
  const split = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
  const label = selected
    ? currentTheme.boldFg('primary', path)
    : currentTheme.fg('textMuted', path.slice(0, split)) + currentTheme.fg('text', path.slice(split));
  const tag = rowSideTag(row);
  const side = tag === undefined ? '' : currentTheme.fg(tag.tone, tag.text);
  const current = row.current
    ? (side === '' ? '' : ' ') + currentTheme.fg('success', CURRENT_MARK)
    : '';
  const tail = side === '' && current === '' ? '' : `${' '.repeat(Math.max(0, pathWidth - visibleWidth(path)))}  ${side}${current}`;
  return pointer + label + tail;
}
