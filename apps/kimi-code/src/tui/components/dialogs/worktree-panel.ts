import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable } from '@moonshot-ai/pi-tui';
import type { KimiWorktree } from '@moonshot-ai/kimi-code-sdk';

import { CURRENT_MARK, SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme, type ColorToken } from '#/tui/theme';
import { abbreviateHome } from '#/tui/utils/home-path';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';

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
  readonly onOpen: (row: WorktreePanelTarget) => void;
  readonly onNew: () => void;
  readonly onDelete: (row: WorktreeRow) => void;
  readonly onCancel: () => void;
}

const HINT = '↑↓ navigate · Enter open · N new · D delete · Esc cancel';
const NEW_ROW_LABEL = '+ New worktree';
const MISSING_NOTICE = "This worktree's directory is missing. Delete it to clean up the git record.";
const SOURCE_DELETE_NOTICE = "You can't delete the source checkout.";
const CURRENT_DELETE_NOTICE = "You're in this worktree. Leave it first, or exit Kimi Code to clean it up.";
const SIDE_COLUMN_WIDTH = visibleWidth(`  source ${CURRENT_MARK}`);

export class WorktreePanelComponent implements Component, Focusable {
  focused = false;
  private readonly list: SearchableList<WorktreePanelRow>;
  private notice: WorktreePanelNotice | undefined;

  constructor(private readonly opts: WorktreePanelOptions) {
    this.list = new SearchableList({
      items: opts.rows,
      toSearchText: () => '',
      pageSize: opts.pageSize,
      initialIndex: opts.rows.findIndex((row) => row.kind !== 'new' && row.current),
    });
  }

  setRows(rows: readonly WorktreePanelRow[]): void {
    this.list.setItems(rows);
  }

  setNotice(notice: WorktreePanelNotice | undefined): void {
    this.notice = notice;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    const row = this.list.selected();
    if (matchesKey(data, Key.enter)) {
      if (row !== undefined) this.open(row);
      return;
    }
    const key = printableChar(data).toLowerCase();
    if (key === 'n') {
      this.opts.onNew();
      return;
    }
    if (key === 'd') {
      if (row !== undefined) this.delete(row);
      return;
    }
    if (this.list.handleKey(data)) this.notice = undefined;
  }

  render(width: number): string[] {
    const view = this.list.view();
    const lines = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Worktrees') + currentTheme.fg('textMuted', `  ${this.opts.repoName}`),
      currentTheme.fg('textMuted', ` ${HINT}`),
    ];
    if (this.notice !== undefined) {
      for (const line of this.notice.text.split('\n')) lines.push(currentTheme.fg(this.notice.tone, ` ${line}`));
    }
    lines.push('');
    const rows = view.items.slice(view.page.start, view.page.end);
    const pathWidth = Math.min(
      Math.max(0, ...rows.map((row) => (row.kind === 'new' ? 0 : visibleWidth(abbreviateHome(rowPath(row)))))),
      Math.max(8, width - 4 - SIDE_COLUMN_WIDTH),
    );
    rows.forEach((row, offset) => {
      lines.push(renderRow(row, view.page.start + offset === view.selectedIndex, pathWidth));
    });
    lines.push('');
    const below = view.items.length - view.page.end;
    if (below > 0) lines.push(currentTheme.fg('textMuted', ` ▼ ${String(below)} more`));
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    const rendered = lines.map((line) => truncateToWidth(line, width));
    return this.focused ? rendered : rendered.map((line) => currentTheme.fade(line));
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
      this.notice = { text: CURRENT_DELETE_NOTICE, tone: 'warning' };
    } else {
      this.opts.onDelete(row);
    }
  }
}

function rowPath(row: WorktreePanelTarget): string {
  return row.kind === 'source' ? row.path : row.worktree.path;
}

function renderRow(row: WorktreePanelRow, selected: boolean, pathWidth: number): string {
  const pointer = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${selected ? SELECT_POINTER : ' '} `);
  if (row.kind === 'new') {
    return pointer + (selected ? currentTheme.boldFg('primary', NEW_ROW_LABEL) : currentTheme.fg('accent', NEW_ROW_LABEL));
  }
  const path = truncatePathLeft(abbreviateHome(rowPath(row)), pathWidth);
  const split = path.lastIndexOf('/') + 1;
  const label = selected
    ? currentTheme.boldFg('primary', path)
    : currentTheme.fg('textMuted', path.slice(0, split)) + currentTheme.fg('text', path.slice(split));
  const side =
    row.kind === 'source'
      ? currentTheme.fg('textMuted', 'source')
      : row.worktree.missing
        ? currentTheme.fg('warning', 'missing')
        : '';
  const current = row.current ? ` ${currentTheme.fg('success', CURRENT_MARK)}` : '';
  const tail = side === '' && current === '' ? '' : `${' '.repeat(pathWidth - visibleWidth(path))}  ${side}${current}`;
  return pointer + label + tail;
}
