/**
 * NotifyPanel — mid-turn updates, shown right above the input area.
 *
 * Updates are grouped into CHANNELS, one per agent: the main agent plus one
 * channel per subagent that posts a `NotifyUser` update. The head is a rule
 * labelled with the channel tabs and a pager; the body is the current update.
 * `Ctrl+N` or a click gives the panel keyboard focus, then `←`/`→` switch
 * channels, `Shift+←`/`→` page through the channel's updates, `↑`/`↓` scroll
 * a docked body, and `Esc`/`Ctrl+N`/`↵` hand focus back to the input area.
 * Any other key hands focus back and goes to the editor, or is ignored while
 * an approval or question stands in for the editor. The wheel scrolls without
 * taking focus. Until the user picks a channel or page, an unfocused panel
 * follows the newest update across channels. A manual selection pins that
 * view; its channel follows its own tail only while unfocused and already on
 * the latest page. Focus freezes the view, and other channels collect an
 * unread dot. Clearing for a new turn restores automatic following.
 *
 * The panel folds to a one-line stub when the turn ends, and while an
 * approval or question waits on a short screen. Focus always
 * unfolds it; once the turn has ended, an ordinary blur keeps it open until
 * an explicit close. The host clears the panel when the next turn starts.
 */

import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { Markdown } from '#/tui/components/markdown/markdown';

import { MAIN_AGENT_ID } from '#/tui/constant/kimi-tui';
import { UPDATES_PROMPT_FOLD_SCREEN_ROWS } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { createMarkdownOptions } from '#/tui/utils/markdown-options';

import { normalizeCapsLockedCtrl } from '../editor/custom-editor';

import { DockSection, type DockLayout, type DockPart } from './dock-section';

export interface NotifyPanelLayout extends DockLayout {
  /** Current terminal height; a short screen folds the panel while a prompt waits. */
  readonly screenRows?: () => number;
}

export interface NotifyEntry {
  readonly id: string;
  readonly agentId: string;
  readonly agentName?: string;
  readonly time: number;
  /** One-line headline of the update; absent for updates posted without one. */
  readonly title?: string;
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

/** What a click on a head segment does. */
type HeadAction =
  | { readonly kind: 'channel'; readonly key: string }
  | { readonly kind: 'prev' }
  | { readonly kind: 'next' }
  | { readonly kind: 'close' }
  | { readonly kind: 'expand' };

interface HeadSegment {
  readonly text: string;
  readonly style: (text: string) => string;
  readonly action?: HeadAction;
}

interface HitTarget {
  readonly from: number;
  readonly to: number;
  readonly action: HeadAction;
}

const BODY_INDENT = '  ';

export class NotifyPanelComponent extends DockSection implements Focusable {
  private readonly channels: NotifyChannel[] = [];
  /** Key of the channel on display; channels themselves are append-only. */
  private activeKey = MAIN_AGENT_ID;
  /** Follow updates across channels until the user picks a channel or page. */
  private followLatest = true;
  private hasFocus = false;
  private ended = false;
  /** Focused since the turn ended: stays open after an ordinary blur, until an explicit close. */
  private keptOpen = false;
  /** Set while an approval or question waits. */
  private promptPending = false;
  private readonly screenRows: (() => number) | undefined;
  private hitTargets: readonly HitTarget[] = [];
  /**
   * Hands keyboard focus back to the input area. `key` is a key the panel
   * does not own, for the editor; undefined when there is nothing to forward.
   */
  onReturnFocus: ((key: string | undefined) => void) | undefined;

  constructor(layout?: NotifyPanelLayout) {
    super(layout);
    this.screenRows = layout?.screenRows;
  }

  /**
   * Add or update an entry. A repeated `id` updates in place. An unfocused
   * panel follows activity across channels until a manual selection pins it.
   * While pinned, the current channel follows its own tail only at the latest
   * page, and other channels collect unread entries.
   */
  upsert(entry: NotifyEntry): void {
    const ch = this.channelFor(entry);
    const following =
      !this.hasFocus && ch.key === this.activeKey && ch.page === ch.entries.length - 1;
    const existing = ch.entries.find((item) => item.id === entry.id);
    if (existing !== undefined) {
      ch.entries[ch.entries.indexOf(existing)] = entry;
    } else {
      ch.entries.push(entry);
    }
    if (!this.hasFocus && this.followLatest) {
      const moved = this.activeKey !== ch.key || ch.page !== ch.entries.length - 1;
      this.activeKey = ch.key;
      ch.page = ch.entries.length - 1;
      ch.unreadIds.clear();
      if (moved) this.scrollBodyToTop();
    } else if (existing === undefined) {
      if (ch.key !== this.activeKey) ch.unreadIds.add(entry.id);
      else if (following) {
        ch.page = ch.entries.length - 1;
        this.scrollBodyToTop();
      }
    }
  }

  remove(id: string): boolean {
    const ch = this.channels.find((channel) => channel.entries.some((entry) => entry.id === id));
    if (ch === undefined) return false;
    const index = ch.entries.findIndex((entry) => entry.id === id);
    ch.entries.splice(index, 1);
    if (ch.entries.length === 0) {
      this.channels.splice(this.channels.indexOf(ch), 1);
      if (ch.key === this.activeKey) {
        this.activeKey = this.channels.at(-1)?.key ?? MAIN_AGENT_ID;
        this.followLatest = true;
      }
    } else {
      ch.page = Math.min(ch.page, ch.entries.length - 1);
      ch.unreadIds.delete(id);
    }
    if (this.channels.length === 0) {
      this.followLatest = true;
      this.dropFocus();
    }
    return true;
  }

  clearUpdates(): void {
    this.channels.length = 0;
    this.activeKey = MAIN_AGENT_ID;
    this.followLatest = true;
    this.dropFocus();
    this.ended = false;
    this.keptOpen = false;
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
   * The turn that produced these updates has ended: fold the panel down to
   * a one-line stub so the final reply owns the screen. A
   * focused user keeps reading, and an ordinary blur does not fold it. Only
   * an explicit Escape, Ctrl+N or close action folds it after the turn ends.
   */
  setEnded(ended: boolean): void {
    if (ended && !this.ended && this.hasFocus) this.keptOpen = true;
    this.ended = ended;
  }

  /**
   * An approval or question waits. The panel keeps its size and focus; only
   * a docked panel on a short screen folds, so the prompt keeps its rows.
   */
  setPrompt(pending: boolean): void {
    this.promptPending = pending;
  }

  /** Set by the TUI when keyboard focus moves to or away from the panel. */
  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    if (value) this.focus();
    else this.blur();
  }

  /** Whether there is something to read. */
  canFocus(): boolean {
    return this.channels.length > 0;
  }

  focus(): boolean {
    if (!this.canFocus()) return false;
    if (this.ended) this.keptOpen = true;
    this.hasFocus = true;
    this.activeChannel().unreadIds.clear();
    return true;
  }

  blur(): boolean {
    if (!this.hasFocus) return false;
    this.hasFocus = false;
    return true;
  }

  /** Folded to the one-line stub while unfocused: the turn ended, or a prompt needs the rows. */
  private isFolded(): boolean {
    return !this.hasFocus && (this.promptNeedsRows() || (this.ended && !this.keptOpen));
  }

  /** An approval or question waits on a screen too short to also show the docked body. */
  private promptNeedsRows(): boolean {
    const screenRows = this.screenRows?.();
    return this.promptPending && screenRows !== undefined && screenRows < UPDATES_PROMPT_FOLD_SCREEN_ROWS;
  }

  /** Hand the keyboard back after an explicit close: a panel that folds unfocused folds now. */
  private close(): void {
    this.keptOpen = false;
    if (this.hasFocus) this.onReturnFocus?.(undefined);
  }

  /** Nothing is left to read: hand the keyboard back to the input area. */
  private dropFocus(): void {
    if (!this.hasFocus) return;
    this.hasFocus = false;
    this.onReturnFocus?.(undefined);
  }

  handleInput(data: string): void {
    const key = normalizeCapsLockedCtrl(data);
    if (matchesKey(key, Key.escape) || matchesKey(key, Key.ctrl('n'))) {
      this.close();
    } else if (matchesKey(key, 'shift+left')) {
      this.prevPage();
    } else if (matchesKey(key, 'shift+right')) {
      this.nextPage();
    } else if (matchesKey(key, Key.left)) {
      this.prevChannel();
    } else if (matchesKey(key, Key.right)) {
      this.nextChannel();
    } else if (matchesKey(key, Key.up)) {
      this.scrollBody(-1);
    } else if (matchesKey(key, Key.down)) {
      this.scrollBody(1);
    } else if (matchesKey(key, Key.enter)) {
      this.onReturnFocus?.(undefined);
    } else {
      this.onReturnFocus?.(data);
    }
  }

  /** Older channel (`←`), landing on its latest update; false on the leftmost tab. */
  prevChannel(): boolean {
    const index = this.activeIndex();
    if (index <= 0) return false;
    this.showChannel(this.channels[index - 1]!.key);
    return true;
  }

  /** Newer channel (`→`), landing on its latest update; false on the rightmost tab. */
  nextChannel(): boolean {
    const index = this.activeIndex();
    if (index >= this.channels.length - 1) return false;
    this.showChannel(this.channels[index + 1]!.key);
    return true;
  }

  /** Older update in the current channel (`Shift+←`); false on the first page. */
  prevPage(): boolean {
    if (this.channels.length === 0) return false;
    const ch = this.activeChannel();
    if (ch.page <= 0) return false;
    this.followLatest = false;
    ch.page -= 1;
    this.scrollBodyToTop();
    return true;
  }

  /** Newer update in the current channel (`Shift+→`); false on the latest page. */
  nextPage(): boolean {
    if (this.channels.length === 0) return false;
    const ch = this.activeChannel();
    if (ch.page >= ch.entries.length - 1) return false;
    this.followLatest = false;
    ch.page += 1;
    this.scrollBodyToTop();
    return true;
  }

  protected renderPart(part: DockPart, width: number): string[] {
    if (this.channels.length === 0) return [];
    if (part === 'foot') return [];
    const folded = this.isFolded();
    if (part === 'body') return folded ? [] : this.bodyRows(width);
    const segments = folded ? this.stubSegments(width) : this.headSegments(width);
    return [this.paintSegments(segments, width)];
  }

  /**
   * A click anywhere takes keyboard focus, on top of what the clicked head
   * segment does; `close` only closes. A press on a head segment is claimed
   * so it does not start a text selection, while the body stays selectable.
   */
  protected override handlePartMouse(
    part: DockPart,
    event: TuiMouseEvent,
  ): TuiMouseEventResult | undefined {
    if (event.button !== 'left') return undefined;
    const target =
      part === 'head' && event.y === 0
        ? this.hitTargets.find((hit) => event.x >= hit.from && event.x < hit.to)
        : undefined;
    if (event.type === 'press' || event.type === 'release') {
      return target === undefined ? undefined : { handled: true };
    }
    if (event.type !== 'click') return undefined;
    const takesFocus = target === undefined || this.runAction(target.action);
    return takesFocus ? { handled: true, focus: true } : { handled: true };
  }

  /** Run a clicked head action; false when it hands the keyboard away rather than taking it. */
  private runAction(action: HeadAction): boolean {
    switch (action.kind) {
      case 'channel':
        this.showChannel(action.key);
        return true;
      case 'prev':
        this.prevPage();
        return true;
      case 'next':
        this.nextPage();
        return true;
      case 'expand':
        return true;
      case 'close':
        this.close();
        return false;
    }
  }

  private showChannel(key: string): void {
    const ch = this.channels.find((channel) => channel.key === key);
    if (ch === undefined) return;
    this.followLatest = false;
    const moved = this.activeKey !== key || ch.page !== ch.entries.length - 1;
    this.activeKey = key;
    ch.page = ch.entries.length - 1;
    ch.unreadIds.clear();
    if (moved) this.scrollBodyToTop();
  }

  private bodyRows(width: number): string[] {
    const inner = Math.max(1, width - BODY_INDENT.length);
    const entry = this.currentEntry();
    const titleRows =
      entry.title === undefined
        ? []
        : wrapTextWithAnsi(entry.title, inner).map((row) => currentTheme.boldFg('textStrong', row));
    const textRows = new Markdown(
      entry.text.trim(),
      0,
      0,
      createMarkdownTheme(),
      undefined,
      createMarkdownOptions(),
    ).render(inner);
    return [...titleRows, ...textRows].map((row) => truncateToWidth(`${BODY_INDENT}${row}`, width));
  }

  private paintSegments(segments: readonly HeadSegment[], width: number): string {
    const targets: HitTarget[] = [];
    let x = 0;
    let line = '';
    for (const segment of segments) {
      const segmentWidth = visibleWidth(segment.text);
      line += segment.style(segment.text);
      if (segment.action !== undefined) {
        targets.push({ from: x, to: x + segmentWidth, action: segment.action });
      }
      x += segmentWidth;
    }
    this.hitTargets = targets.filter((target) => target.to <= width);
    return truncateToWidth(line, width);
  }

  /**
   * The expanded head: a rule labelled with the channel tabs, the pager and a
   * key hint, plus a leave button while focused or kept open. Slims down as
   * width shrinks: first the hint goes, then the other tabs, then the label
   * altogether.
   */
  private headSegments(width: number): HeadSegment[] {
    const rule = (text: string) => currentTheme.fg(this.hasFocus ? 'primary' : 'border', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const ch = this.activeChannel();
    const label = (tabs: HeadSegment[], hint: string): HeadSegment[] => {
      const segments: HeadSegment[] = [{ text: '─ ', style: rule }, ...tabs];
      if (hint.length > 0) segments.push({ text: ` · ${hint}`, style: dim });
      segments.push({ text: ' ', style: rule });
      return segments;
    };
    const leave = (text: string): HeadSegment[] => {
      if (!this.hasFocus && !this.keptOpen) return [];
      return [
        { text: ' ', style: rule },
        { text: this.hasFocus ? text : 'close', style: dim, action: { kind: 'close' } },
        { text: ' ─', style: rule },
      ];
    };
    const focusedHints: string[] = [];
    if (this.channels.length > 1) focusedHints.push('←→ agent');
    if (this.bodyOverflows(width)) focusedHints.push('↑↓ scroll');
    if (ch.entries.length > 1) focusedHints.push('shift+←→ update');
    const hint = this.hasFocus ? focusedHints.join(' · ') : 'ctrl+n to browse';
    const escape = this.ended || this.promptNeedsRows() ? 'esc close' : 'esc back';
    const candidates: [HeadSegment[], HeadSegment[]][] = [
      [label(this.tabSegments(true), hint), leave(escape)],
      [label(this.tabSegments(true), ''), leave(escape)],
      [label(this.tabSegments(true, [ch]), ''), leave('esc')],
    ];
    for (const [left, right] of candidates) {
      const fill = width - segmentsWidth(left) - segmentsWidth(right);
      if (fill >= 1) return [...left, { text: '─'.repeat(fill), style: rule }, ...right];
    }
    return [{ text: '─'.repeat(width), style: rule }];
  }

  /**
   * The collapsed one-liner: an expand marker, the channel tabs, the total
   * update count, and a preview of the current entry's first line —
   * everything the user needs to decide whether to open the panel. A click on
   * a tab opens that channel; anywhere else opens the current one.
   */
  private stubSegments(width: number): HeadSegment[] {
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const expand: HeadAction = { kind: 'expand' };
    const marker: HeadSegment = {
      text: ' ▸ ',
      style: (text) => currentTheme.fg('primary', text),
      action: expand,
    };
    const total = this.channels.reduce((sum, ch) => sum + ch.entries.length, 0);
    const count = `${String(total)} ${total === 1 ? 'update' : 'updates'}`;
    const tail: HeadSegment = { text: ' · ctrl+n to expand', style: dim, action: expand };
    const head = [marker, ...this.tabSegments(), { text: ` · ${count}`, style: dim, action: expand }];
    const preview = this.previewText(this.currentEntry());
    if (preview !== undefined) {
      const budget = width - segmentsWidth(head) - segmentsWidth([tail]) - 3;
      if (budget >= 12) {
        return [...head, { text: ` · ${truncateToWidth(preview, budget)}`, style: dim, action: expand }, tail];
      }
    }
    if (segmentsWidth(head) + segmentsWidth([tail]) <= width) return [...head, tail];
    return [marker, { text: `${count} · ctrl+n to expand`, style: dim, action: expand }];
  }

  private tabSegments(
    withPager = false,
    channels: readonly NotifyChannel[] = this.channels,
  ): HeadSegment[] {
    const segments: HeadSegment[] = [];
    for (const [index, channel] of channels.entries()) {
      if (index > 0) segments.push({ text: ' · ', style: (text) => currentTheme.fg('textDim', text) });
      const active = channel.key === this.activeKey;
      segments.push(this.tabSegment(channel, active));
      if (withPager && active && channel.entries.length > 1) {
        const strong = (text: string) =>
          this.hasFocus ? currentTheme.boldFg('primary', text) : currentTheme.boldFg('textDim', text);
        segments.push(
          { text: ' ', style: strong },
          { text: '<', style: strong, action: { kind: 'prev' } },
          { text: ` ${String(channel.page + 1)}/${String(channel.entries.length)} `, style: strong },
          { text: '>', style: strong, action: { kind: 'next' } },
        );
      }
    }
    return segments;
  }

  private tabSegment(channel: NotifyChannel, active: boolean): HeadSegment {
    const action: HeadAction = { kind: 'channel', key: channel.key };
    if (active) {
      return {
        text: channel.label,
        style: (text) =>
          this.hasFocus ? currentTheme.boldFg('primary', text) : currentTheme.boldFg('textDim', text),
        action,
      };
    }
    if (channel.unreadIds.size === 0) {
      return { text: channel.label, style: (text) => currentTheme.fg('textDim', text), action };
    }
    return {
      text: `${channel.label}●`,
      style: (text) =>
        currentTheme.fg('textDim', text.slice(0, -1)) + currentTheme.fg('primary', '●'),
      action,
    };
  }

  /** An entry's title, else its first non-empty line stripped of list/bold markers. */
  private previewText(entry: NotifyEntry): string | undefined {
    if (entry.title !== undefined) return entry.title;
    const firstLine = entry.text
      .trim()
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim()
      .replace(/^[-*#>\s]+/, '')
      .replaceAll('**', '');
    return firstLine === undefined || firstLine.length === 0 ? undefined : firstLine;
  }

  private currentEntry(): NotifyEntry {
    const ch = this.activeChannel();
    return ch.entries[Math.min(ch.page, ch.entries.length - 1)]!;
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
    if (this.channels.length === 0) this.activeKey = key;
    if (key === MAIN_AGENT_ID) this.channels.unshift(created);
    else this.channels.push(created);
    return created;
  }

  /** Dedup identical labels as `explore`, `explore_2`, `explore_3`, … */
  private labelFor(base: string): string {
    if (!this.channels.some((ch) => ch.label === base)) return base;
    let n = 2;
    while (this.channels.some((ch) => ch.label === `${base}_${String(n)}`)) n += 1;
    return `${base}_${String(n)}`;
  }

  private activeIndex(): number {
    const index = this.channels.findIndex((ch) => ch.key === this.activeKey);
    return Math.max(0, index);
  }

  private activeChannel(): NotifyChannel {
    return this.channels[this.activeIndex()]!;
  }
}

function segmentsWidth(segments: readonly HeadSegment[]): number {
  return segments.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
}
