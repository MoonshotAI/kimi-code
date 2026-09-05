/**
 * NotifyPanel — the model's mid-turn updates, shown right above the input
 * area (below the Todo panel).
 *
 * Fed by `NotifyUser` tool calls: every call is one entry, and the entries
 * of the current turn stack chronologically, newest at the bottom, each
 * rendered as Markdown behind a marker (`◆` newest, `◇` earlier). The body
 * is a window of {@link NOTIFY_PANEL_MAX_BODY_LINES} rows that follows the
 * tail, so the latest updates are always in view; `Ctrl+N` pages up through
 * earlier rows and wraps back to the tail, and a new update snaps the view
 * back to the tail. The host clears the panel when the next turn starts, so
 * it never mixes turns; a finished turn only dims the title.
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { Markdown, truncateToWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { NOTIFY_PANEL_MAX_BODY_LINES } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { createMarkdownOptions } from '#/tui/utils/markdown-options';

const BODY_INDENT = '  ';
/** `◆ ` in front of an entry's first row; continuation rows get the same width of spaces. */
const MARKER_INDENT = '  ';
const PAGE_KEY_HINT = 'ctrl+n earlier';

interface NotifyEntry {
  readonly id: string;
  text: string;
}

export class NotifyPanelComponent implements Component {
  private readonly entries: NotifyEntry[] = [];
  /** First body row in view; `null` follows the tail. */
  private scrollTop: number | null = null;
  private ended = false;
  /** Total stacked body rows from the last render; drives paging. */
  private lastTotalRows = 0;

  /**
   * Add or update an entry. A repeated `id` updates the entry in place (the
   * same tool call streaming its `message`); a new id appends and snaps the
   * view back to the tail.
   */
  upsert(id: string, text: string): void {
    const existing = this.entries.find((entry) => entry.id === id);
    if (existing !== undefined) {
      existing.text = text;
      return;
    }
    this.entries.push({ id, text });
    this.scrollTop = null;
    this.ended = false;
  }

  clear(): void {
    this.entries.length = 0;
    this.scrollTop = null;
    this.ended = false;
    this.lastTotalRows = 0;
  }

  /**
   * Drop one entry — a call that was denied, failed, or never completed. The
   * view snaps back to the tail. Returns false when the id is unknown.
   */
  remove(id: string): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    this.entries.splice(index, 1);
    this.scrollTop = null;
    if (this.entries.length === 0) this.lastTotalRows = 0;
    return true;
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  getEntries(): readonly { readonly id: string; readonly text: string }[] {
    return this.entries.map((entry) => ({ id: entry.id, text: entry.text }));
  }

  /** The turn that produced these updates has ended; keep them, dim the title. */
  setEnded(ended: boolean): void {
    this.ended = ended;
  }

  /** True when the stacked rows overflow the window, so Ctrl+N has somewhere to go. */
  hasMorePages(): boolean {
    return this.lastTotalRows > NOTIFY_PANEL_MAX_BODY_LINES;
  }

  /**
   * Page up one window through earlier rows; from the top, wrap back to the
   * tail. Returns false when everything already fits so the key can fall
   * through.
   */
  nextPage(): boolean {
    if (!this.hasMorePages()) return false;
    const cap = NOTIFY_PANEL_MAX_BODY_LINES;
    const tailStart = this.lastTotalRows - cap;
    const current = this.scrollTop ?? tailStart;
    if (current <= 0) {
      this.scrollTop = null;
      return true;
    }
    this.scrollTop = Math.max(0, current - cap);
    return true;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.entries.length === 0) return [];
    const c = currentTheme.palette;
    const rows = this.renderRows(width);
    this.lastTotalRows = rows.length;

    const cap = NOTIFY_PANEL_MAX_BODY_LINES;
    const tailStart = Math.max(0, rows.length - cap);
    let start = this.scrollTop ?? tailStart;
    if (start > tailStart) {
      start = tailStart;
      this.scrollTop = null;
    }
    const shown = rows.slice(start, start + cap);
    const later = rows.length - (start + shown.length);

    const lines: string[] = [chalk.hex(c.border)('─'.repeat(width)), this.renderTitle()];
    if (start > 0) {
      lines.push(chalk.hex(c.textDim)(`${BODY_INDENT}… ${String(start)} earlier lines`));
    }
    lines.push(...shown);
    if (later > 0) {
      lines.push(chalk.hex(c.textDim)(`${BODY_INDENT}… ${String(later)} later lines`));
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  /** Every entry's Markdown rows, stacked in order, each behind its marker. */
  private renderRows(width: number): string[] {
    const c = currentTheme.palette;
    const markdownWidth = Math.max(1, width - BODY_INDENT.length - MARKER_INDENT.length);
    const rows: string[] = [];
    for (const [index, entry] of this.entries.entries()) {
      const newest = index === this.entries.length - 1;
      const marker = newest ? chalk.hex(c.primary)('◆') : chalk.hex(c.textDim)('◇');
      const body = new Markdown(
        entry.text.trim(),
        0,
        0,
        createMarkdownTheme(),
        undefined,
        createMarkdownOptions(),
      ).render(markdownWidth);
      for (const [i, row] of body.entries()) {
        rows.push(i === 0 ? `${BODY_INDENT}${marker} ${row}` : `${BODY_INDENT}${MARKER_INDENT}${row}`);
      }
    }
    return rows;
  }

  private renderTitle(): string {
    const c = currentTheme.palette;
    const marker = this.ended ? '◇' : '◆';
    const label =
      this.entries.length > 1 ? `Updates (${String(this.entries.length)})` : 'Update';
    const title = `${BODY_INDENT}${marker} ${label}`;
    const styledTitle = this.ended
      ? chalk.hex(c.textDim).bold(title)
      : chalk.hex(c.primary).bold(title);
    const hints: string[] = [];
    if (this.hasMorePages()) hints.push(PAGE_KEY_HINT);
    if (this.ended) hints.push('turn ended · next message clears');
    const hint = hints.length > 0 ? chalk.hex(c.textDim)(` · ${hints.join(' · ')}`) : '';
    return `${styledTitle}${hint}`;
  }
}
