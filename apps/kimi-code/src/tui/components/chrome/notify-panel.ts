import type { Component } from '@moonshot-ai/pi-tui';
import { Markdown, truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import { MAIN_AGENT_ID } from '#/tui/constant/kimi-tui';
import { NOTIFY_PANEL_PAGE_LINES } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { createMarkdownOptions } from '#/tui/utils/markdown-options';

export interface NotifyEntry {
  readonly id: string;
  readonly agentId: string;
  readonly time: number;
  readonly text: string;
}

export class NotifyPanelComponent implements Component {
  private readonly entries: NotifyEntry[] = [];
  private pageIndex: number | undefined;
  private firstPageLines: number | undefined;
  private readonly unseen = new Set<string>();
  private rows: Array<{ line: string; prefix: string; indent: number; first: boolean }> = [];
  private width: number | undefined;
  private palette: typeof currentTheme.palette | undefined;
  private dirty = true;
  private frame: string[] | undefined;
  private readonly bodies = new Map<
    string,
    { text: string; width: number; palette: typeof currentTheme.palette; lines: string[] }
  >();

  upsert(entry: NotifyEntry): void {
    const index = this.entries.findIndex((item) => item.id === entry.id);
    if (index >= 0) this.entries[index] = entry;
    else {
      this.entries.push(entry);
      if (this.pageIndex !== undefined) this.unseen.add(entry.id);
    }
    this.dirty = true;
    this.frame = undefined;
  }

  clear(): void {
    this.entries.length = 0;
    this.rows = [];
    this.pageIndex = undefined;
    this.firstPageLines = undefined;
    this.unseen.clear();
    this.bodies.clear();
    this.dirty = true;
    this.frame = undefined;
  }

  remove(id: string): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    this.bodies.delete(id);
    this.unseen.delete(id);
    if (this.entries.length === 0) this.clear();
    this.dirty = true;
    this.frame = undefined;
    return true;
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  getEntries(): readonly NotifyEntry[] {
    return this.entries;
  }

  changePage(direction: -1 | 1): boolean {
    if (this.width === undefined) return false;
    this.updateRows(this.width);
    const lastPage = this.lastPage();
    if (lastPage === 0) return false;
    this.firstPageLines = this.firstPageSize();
    const target = Math.max(0, Math.min(lastPage, (this.pageIndex ?? lastPage) + direction));
    this.pageIndex = target === lastPage ? undefined : target;
    if (this.pageIndex === undefined) {
      this.firstPageLines = undefined;
      this.unseen.clear();
    }
    this.frame = undefined;
    return true;
  }

  invalidate(): void {
    this.bodies.clear();
    this.dirty = true;
    this.frame = undefined;
  }

  render(width: number): string[] {
    if (width <= 0 || this.entries.length === 0) return [];
    this.updateRows(width);
    if (this.frame !== undefined) return this.frame;
    const lastPage = this.lastPage();
    const page = this.pageIndex ?? lastPage;
    const hints = [`${String(page + 1)}/${String(lastPage + 1)}`];
    if (lastPage > 0) hints.push('Ctrl+P prev', 'Ctrl+N next');
    if (this.unseen.size > 0)
      hints.push(
        `${String(this.unseen.size)} new ${this.unseen.size === 1 ? 'update' : 'updates'}`,
      );
    const title =
      currentTheme.boldFg('primary', '  Updates') +
      currentTheme.fg('textMuted', ` · ${hints.join(' · ')}`);
    const end = this.firstPageSize() + page * NOTIFY_PANEL_PAGE_LINES;
    const body = this.rows
      .slice(Math.max(0, end - NOTIFY_PANEL_PAGE_LINES), end)
      .map(
        (row, index) =>
          `${row.first || index === 0 ? row.prefix : ' '.repeat(row.indent)}${row.line}`,
      );
    this.frame = [title, ...body].map((line) => truncateToWidth(line, width));
    return this.frame;
  }

  private lastPage(): number {
    return Math.max(
      0,
      Math.ceil((this.rows.length - this.firstPageSize()) / NOTIFY_PANEL_PAGE_LINES),
    );
  }

  private firstPageSize(): number {
    return this.firstPageLines ?? ((this.rows.length - 1) % NOTIFY_PANEL_PAGE_LINES) + 1;
  }

  private updateRows(width: number): void {
    if (!this.dirty && this.width === width && this.palette === currentTheme.palette) return;
    if (this.width !== width) this.firstPageLines = undefined;
    this.width = width;
    this.palette = currentTheme.palette;
    this.rows = [];
    for (const entry of this.entries) {
      let prefix = '  ';
      if (entry.agentId !== MAIN_AGENT_ID) {
        prefix += currentTheme.fg('textMuted', `[${entry.agentId}] `);
      }
      const indent = Math.min(visibleWidth(prefix), Math.max(0, width - 1));
      const bodyWidth = Math.max(1, width - indent);
      let body = this.bodies.get(entry.id);
      if (
        body === undefined ||
        body.text !== entry.text ||
        body.width !== bodyWidth ||
        body.palette !== currentTheme.palette
      ) {
        const lines = new Markdown(
          entry.text.trim(),
          0,
          0,
          createMarkdownTheme(),
          undefined,
          createMarkdownOptions(),
        ).render(bodyWidth);
        body = { text: entry.text, width: bodyWidth, palette: currentTheme.palette, lines };
        this.bodies.set(entry.id, body);
      }
      const firstPrefix =
        visibleWidth(prefix) <= indent ? prefix : truncateToWidth(prefix, indent, '');
      for (const [row, line] of body.lines.entries())
        this.rows.push({ line, prefix: firstPrefix, indent, first: row === 0 });
    }
    if (this.pageIndex !== undefined && this.pageIndex >= this.lastPage()) {
      this.pageIndex = undefined;
      this.firstPageLines = undefined;
      this.unseen.clear();
    } else if (this.pageIndex !== undefined) {
      this.firstPageLines = this.firstPageSize();
    }
    this.dirty = false;
    this.frame = undefined;
  }
}
