/**
 * NotifyPanel — mid-turn updates, shown as a bordered box right above the
 * input area (below the Todo panel), visually matching the editor.
 *
 * Updates are grouped into CHANNELS, one per agent: the main agent plus one
 * channel per subagent that posts a `NotifyUser` update. The top border is a
 * tab strip of channel labels; `Ctrl+N` focuses the box, then `←`/`→` switch
 * channels and `↑`/`↓` page through the current channel's updates. While the
 * user is not focused, the view follows the latest activity across channels;
 * while focused it stays put and other channels collect an unread dot.
 * Entries render at their natural height — the box adapts instead of
 * truncating. When the turn ends the box folds to a one-line stub until the
 * user focuses it; the host clears the box when the next turn starts.
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { Markdown, truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { MAIN_AGENT_ID } from '#/tui/constant/kimi-tui';
import { currentTheme } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { createMarkdownOptions } from '#/tui/utils/markdown-options';

import { wrapWithSideBorders } from '../editor/custom-editor';

export interface NotifyEntry {
  readonly id: string;
  readonly agentId: string;
  readonly agentName?: string;
  readonly time: number;
  readonly text: string;
}

export interface NotifyChannelView {
  readonly label: string;
  readonly entries: readonly { readonly id: string; readonly text: string }[];
  readonly unread: number;
}

interface NotifyChannel {
  readonly key: string;
  readonly label: string;
  readonly entries: NotifyEntry[];
  /** Page (entry index) the user last read in this channel. */
  page: number;
  /** Ids of entries that arrived while the user was reading another channel. */
  readonly unreadIds: Set<string>;
}

function padToVisibleWidth(text: string, target: number): string {
  const truncated = truncateToWidth(text, target);
  const gap = target - visibleWidth(truncated);
  return gap > 0 ? truncated + ' '.repeat(gap) : truncated;
}

export class NotifyPanelComponent implements Component {
  private readonly channels: NotifyChannel[] = [];
  /** Key of the channel on display; channels themselves are append-only. */
  private activeKey = MAIN_AGENT_ID;
  private focused = false;
  private ended = false;
  /** Turn ended and no one is reading: the box folds to a one-line stub. */
  private collapsed = false;

  /**
   * Add or update an entry in a channel. A repeated `id` updates the entry in
   * place; a new id appends. While unfocused the view jumps to the entry's
   * channel and its tail — the latest activity always wins; while focused the
   * user's page stays put and background channels collect unread instead.
   */
  upsert(entry: NotifyEntry): void {
    const ch = this.channelFor(entry);
    const existing = ch.entries.find((item) => item.id === entry.id);
    const isNew = existing === undefined;
    if (existing !== undefined) ch.entries[ch.entries.indexOf(existing)] = entry;
    else ch.entries.push(entry);
    if (!this.focused) {
      this.activeKey = ch.key;
      ch.page = ch.entries.length - 1;
      ch.unreadIds.clear();
    } else if (isNew && ch.key !== this.activeKey) {
      ch.unreadIds.add(entry.id);
    }
    this.ended = false;
    this.collapsed = false;
  }

  remove(id: string): boolean {
    const ch = this.channels.find((channel) => channel.entries.some((entry) => entry.id === id));
    if (ch === undefined) return false;
    const index = ch.entries.findIndex((entry) => entry.id === id);
    ch.entries.splice(index, 1);
    if (ch.entries.length === 0) {
      this.channels.splice(this.channels.indexOf(ch), 1);
      if (ch.key === this.activeKey) this.activeKey = this.channels.at(-1)?.key ?? MAIN_AGENT_ID;
    } else {
      ch.page = Math.min(ch.page, ch.entries.length - 1);
      ch.unreadIds.delete(id);
    }
    if (this.channels.length === 0) this.focused = false;
    return true;
  }

  clear(): void {
    this.channels.length = 0;
    this.activeKey = MAIN_AGENT_ID;
    this.focused = false;
    this.ended = false;
    this.collapsed = false;
  }

  isEmpty(): boolean {
    return this.channels.length === 0;
  }

  getChannels(): readonly NotifyChannelView[] {
    return this.channels.map((ch) => ({
      label: ch.label,
      entries: ch.entries.map((entry) => ({ id: entry.id, text: entry.text })),
      unread: ch.unreadIds.size,
    }));
  }

  /** Every entry across channels, in display order (main first, then arrival). */
  getEntries(): readonly NotifyEntry[] {
    return this.channels.flatMap((ch) => ch.entries);
  }

  /**
   * The turn that produced these updates has ended: dim the title and fold
   * the box down to a one-line stub so the final reply owns the screen. A
   * focused user keeps reading — the fold lands when they blur.
   */
  setEnded(ended: boolean): void {
    this.ended = ended;
    if (ended && !this.focused) this.collapsed = true;
    if (!ended) this.collapsed = false;
  }

  /** Grab keyboard paging for the box; returns false when there is nothing to read. */
  focus(): boolean {
    if (this.channels.length === 0) return false;
    this.focused = true;
    this.collapsed = false;
    this.activeChannel().unreadIds.clear();
    return true;
  }

  blur(): boolean {
    if (!this.focused) return false;
    this.focused = false;
    if (this.ended) this.collapsed = true;
    return true;
  }

  isFocused(): boolean {
    return this.focused;
  }

  /** Older channel (`←`), landing on its latest update; false on the leftmost tab. */
  prevChannel(): boolean {
    const index = this.activeIndex();
    if (index <= 0) return false;
    this.activeKey = this.channels[index - 1]!.key;
    const ch = this.activeChannel();
    ch.page = ch.entries.length - 1;
    ch.unreadIds.clear();
    return true;
  }

  /** Newer channel (`→`), landing on its latest update; false on the rightmost tab. */
  nextChannel(): boolean {
    const index = this.activeIndex();
    if (index >= this.channels.length - 1) return false;
    this.activeKey = this.channels[index + 1]!.key;
    const ch = this.activeChannel();
    ch.page = ch.entries.length - 1;
    ch.unreadIds.clear();
    return true;
  }

  /** Older update in the current channel (`↑`); false on the first page. */
  prevPage(): boolean {
    if (this.channels.length === 0) return false;
    const ch = this.activeChannel();
    if (ch.page <= 0) return false;
    ch.page -= 1;
    return true;
  }

  /** Newer update in the current channel (`↓`); false on the latest page. */
  nextPage(): boolean {
    if (this.channels.length === 0) return false;
    const ch = this.activeChannel();
    if (ch.page >= ch.entries.length - 1) return false;
    ch.page += 1;
    return true;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.channels.length === 0) return [];
    const c = currentTheme.palette;
    const paint = chalk.hex(this.focused ? c.primary : c.border);

    if (this.collapsed) {
      return ['', this.stubLine(width)].map((line) => truncateToWidth(line, width));
    }

    const innerWidth = Math.max(1, width - 6);
    const ch = this.activeChannel();
    const entry = ch.entries[Math.min(ch.page, ch.entries.length - 1)]!;
    const bodyRows = new Markdown(
      entry.text.trim(),
      0,
      0,
      createMarkdownTheme(),
      undefined,
      createMarkdownOptions(),
    ).render(innerWidth);

    const padRow = (row: string): string => `   ${padToVisibleWidth(row, width - 6)}   `;
    const emptyRow = ' '.repeat(width);
    const lines: string[] = ['─'.repeat(width), emptyRow];
    for (const row of bodyRows) {
      lines.push(padRow(row));
    }
    lines.push(emptyRow, '─'.repeat(width));

    const boxed = wrapWithSideBorders(lines, paint, { label: this.title(width) });
    return ['', ...boxed].map((line) => truncateToWidth(line, width));
  }

  private channelFor(entry: NotifyEntry): NotifyChannel {
    const key = entry.agentId;
    const found = this.channels.find((ch) => ch.key === key);
    if (found !== undefined) return found;
    const created: NotifyChannel = {
      key,
      label: this.labelFor(entry.agentName ?? key),
      entries: [],
      page: 0,
      unreadIds: new Set(),
    };
    if (key === MAIN_AGENT_ID) this.channels.unshift(created);
    else this.channels.push(created);
    return created;
  }

  /** Dedup identical labels as `explore`, `explore(2)`, `explore(3)`, … */
  private labelFor(base: string): string {
    if (!this.channels.some((ch) => ch.label === base)) return base;
    let n = 2;
    while (this.channels.some((ch) => ch.label === `${base}(${String(n)})`)) n += 1;
    return `${base}(${String(n)})`;
  }

  private activeIndex(): number {
    const index = this.channels.findIndex((ch) => ch.key === this.activeKey);
    return Math.max(0, index);
  }

  private activeChannel(): NotifyChannel {
    return this.channels[this.activeIndex()]!;
  }

  /**
   * The collapsed one-liner: an expand hint marker, the channel tabs, the
   * total update count, and a preview of the current entry's first line —
   * everything the user needs to decide whether to open the box.
   */
  private stubLine(width: number): string {
    const c = currentTheme.palette;
    const dim = chalk.hex(c.textDim);
    const marker = chalk.hex(c.primary)('▸');
    const tabs = this.channels
      .map((channel) => this.renderTab(channel, channel.key === this.activeKey))
      .join(dim(' · '));
    const total = this.channels.reduce((sum, ch) => sum + ch.entries.length, 0);
    const noun = total === 1 ? 'update' : 'updates';
    const head = ` ${marker} ${tabs} ${dim(`· ${String(total)} ${noun}`)}`;
    const tail = ` ${dim('· ctrl+n')}`;
    const preview = this.stubPreviewText();
    if (preview !== undefined) {
      const budget = width - visibleWidth(head) - visibleWidth(tail) - 3;
      if (budget >= 12) return `${head} ${dim('·')} ${dim(truncateToWidth(preview, budget))}${tail}`;
    }
    if (visibleWidth(head) + visibleWidth(tail) <= width) return `${head}${tail}`;
    return ` ${marker} ${dim(`${String(total)} ${noun} · ctrl+n`)}`;
  }

  /** First non-empty line of the current entry, stripped of list/bold markers. */
  private stubPreviewText(): string | undefined {
    const ch = this.activeChannel();
    const entry = ch.entries[Math.min(ch.page, ch.entries.length - 1)];
    if (entry === undefined) return undefined;
    const firstLine = entry.text
      .trim()
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim()
      .replace(/^[-*#>\s]+/, '')
      .replaceAll('**', '');
    return firstLine === undefined || firstLine.length === 0 ? undefined : firstLine;
  }

  /**
   * The styled top-border label: a tab strip of channel labels (active tab
   * highlighted, background channels with unread dotted), then the page
   * indicator and key hints, slimmed down progressively as width shrinks.
   */
  private title(width: number): string | undefined {
    const c = currentTheme.palette;
    const ch = this.activeChannel();
    const page = `${String(ch.page + 1)}/${String(ch.entries.length)}`;
    const state = this.ended ? ' · turn ended' : '';
    const hint = this.focused ? ' · ← → agent · ↑ ↓ update · esc close' : ' · ctrl+n page';
    const paintTitle = this.ended ? chalk.hex(c.textDim).bold : chalk.hex(c.primary).bold;
    const tabs = this.channels
      .map((channel) => this.renderTab(channel, channel.key === this.activeKey))
      .join(chalk.hex(c.textDim)(' · '));
    const full = ` ${tabs} · Updates ${page}${state}${hint} `;
    if (visibleWidth(full) <= width - 4) return paintTitle(full);
    const compact = ` ${ch.label} · Updates ${page}${state} `;
    return visibleWidth(compact) <= width - 4 ? paintTitle(compact) : undefined;
  }

  private renderTab(channel: NotifyChannel, active: boolean): string {
    const c = currentTheme.palette;
    if (active) return chalk.hex(c.primary).bold(channel.label);
    const label = channel.unreadIds.size > 0 ? `${channel.label}●` : channel.label;
    return channel.unreadIds.size > 0 ? chalk.hex(c.primary)(label) : chalk.hex(c.textDim)(label);
  }
}
