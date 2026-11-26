import {
  Box,
  HStack,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  VStack,
  type Component,
  type MarkdownTheme,
  type StackEntryOptions,
  type TuiMouseDispatchResult,
  type TuiMouseEvent,
} from '@moonshot-ai/pi-tui';

import { CHROME_GUTTER, THINKING_PREVIEW_LINES } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';
import type { KimiMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import type { InlineSkillActivation } from '#/tui/types';
import { createMarkdownOptions } from '#/tui/utils/markdown-options';

import { mouseTarget, OverflowScrollView } from '../chrome/dock-section';
import { Markdown } from '../markdown/markdown';

type BtwPanelPhase = 'running' | 'done' | 'failed';

const MIN_COLLAPSED_PANEL_LINES = 3;
const CLOSE_LABEL = 'Esc close';

const paintBorder = (text: string): string => currentTheme.fg('border', text);

interface BtwTurn {
  readonly prompt: string;
  answer: string;
  thinking: string;
  error?: string;
  phase: BtwPanelPhase;
}

interface BtwBodyRender {
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

interface TurnLinesCache {
  readonly revision: number;
  readonly width: number;
  readonly lines: readonly string[];
}

export interface BtwPanelOptions {
  readonly markdownTheme: MarkdownTheme;
  readonly canUseScrollKeys: () => boolean;
  readonly onPrompt: (
    prompt: string,
    inlineSkillActivations?: readonly InlineSkillActivation[],
  ) => void;
  readonly terminalRows: () => number;
  readonly fullscreen?: boolean;
  readonly onClose?: () => void;
}

function padLines(lines: readonly string[], targetRows: number): readonly string[] {
  if (lines.length >= targetRows) return lines;
  const padded = [...lines];
  while (padded.length < targetRows) padded.push('');
  return padded;
}

class BtwFrameBox extends Box {
  private closeRange: { readonly start: number; readonly end: number } | undefined;

  constructor(private readonly onClose: (() => void) | undefined) {
    super({
      border: { top: true, left: true, right: true },
      borderStyle: 'rounded',
      borderColor: paintBorder,
      padding: { left: 1 },
    });
  }

  updateHeader(title: string, closeStart: number, closeEnd: number): void {
    this.setTitle(title);
    this.closeRange = { start: closeStart, end: closeEnd };
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    if (
      this.onClose !== undefined &&
      event.y === 0 &&
      event.button === 'left' &&
      this.closeRange !== undefined &&
      event.x >= this.closeRange.start &&
      event.x < this.closeRange.end &&
      event.x < event.width - 1 &&
      (event.type === 'press' || event.type === 'release' || event.type === 'click')
    ) {
      if (event.type === 'click') this.onClose();
      return { handled: true, target: mouseTarget(this, event) };
    }
    return undefined;
  }
}

export class BtwPanelComponent extends VStack {
  private readonly turns: BtwTurn[] = [];
  private readonly transientNotices: string[] = [];
  private minBodyLines = 0;
  private followTail = true;
  private scrollTop = 0;
  private maxScrollTop = 0;
  private contentRevision = 0;
  private turnLinesCache: TurnLinesCache | undefined;
  private readonly frameBox: BtwFrameBox | undefined;
  private readonly bodyScroll: OverflowScrollView | undefined;
  private readonly rowEntryOptions: { maxSize?: number } | undefined;

  constructor(private readonly options: BtwPanelOptions) {
    super();
    if (options.fullscreen === true) {
      const bodyComponent: Component = {
        render: (width) => {
          this.syncFullscreenHeader();
          return this.renderUnclippedBody(width);
        },
        invalidate: () => {},
      };
      this.bodyScroll = new OverflowScrollView(bodyComponent, {
        follow: 'end',
        onScroll: (top) => {
          this.scrollTop = top;
          if (this.bodyScroll !== undefined && this.bodyScroll.viewportHeight > 0) {
            this.followTail = this.bodyScroll.isFollowingEnd;
          }
        },
      });
      this.frameBox = new BtwFrameBox(options.onClose);
      this.frameBox.addChild(this.bodyScroll);
      const row = new HStack([
        { component: new Spacer(0), basis: CHROME_GUTTER, shrink: 0 },
        { component: this.frameBox, basis: 0, grow: 1, shrink: 1 },
        { component: new Spacer(0), basis: CHROME_GUTTER, shrink: 0 },
      ]);
      const entryOpts: StackEntryOptions = {
        shrink: 1,
        minSize: 0,
        maxSize: this.maxFullscreenPanelRows(),
      };
      this.addChild(row, entryOpts);
      this.rowEntryOptions = this.entries[0];
      this.syncFullscreenHeader();
    }
  }

  override invalidate(): void {
    this.turnLinesCache = undefined;
    super.invalidate();
  }

  submit(prompt: string, inlineSkillActivations?: readonly InlineSkillActivation[]): void {
    const normalized = prompt.trim();
    if (normalized.length === 0 || this.isRunning()) return;
    this.followTail = true;
    this.scrollTop = 0;
    this.transientNotices.length = 0;
    this.turns.push({
      prompt: normalized,
      answer: '',
      thinking: '',
      phase: 'running',
    });
    this.contentRevision += 1;
    this.bodyScroll?.scrollToEnd();
    this.options.onPrompt(normalized, inlineSkillActivations);
  }

  addTransientNotice(message: string): void {
    this.transientNotices.push(message);
    this.contentRevision += 1;
    this.followTail = true;
    this.bodyScroll?.scrollToEnd();
  }

  appendAnswer(delta: string): void {
    const turn = this.currentTurn();
    if (turn === undefined) return;
    turn.answer += delta;
    this.contentRevision += 1;
  }

  appendThinking(delta: string): void {
    const turn = this.currentTurn();
    if (turn === undefined) return;
    turn.thinking += delta;
    this.contentRevision += 1;
  }

  markDone(resultSummary?: string): void {
    const turn = this.currentTurn();
    if (turn === undefined) return;
    if (turn.answer.trim().length === 0 && resultSummary !== undefined) {
      turn.answer = resultSummary;
    }
    this.transientNotices.length = 0;
    turn.phase = 'done';
    this.contentRevision += 1;
  }

  markFailed(error: string): void {
    const turn = this.currentTurn();
    if (turn === undefined || turn.phase !== 'running') {
      this.turns.push({
        prompt: '',
        answer: '',
        thinking: '',
        error,
        phase: 'failed',
      });
      this.transientNotices.length = 0;
      this.contentRevision += 1;
      return;
    }
    turn.error = error;
    this.transientNotices.length = 0;
    turn.phase = 'failed';
    this.contentRevision += 1;
  }

  consumeOverflowChange(): boolean {
    if (this.bodyScroll === undefined) return false;
    const changed = this.bodyScroll.consumeOverflowChange();
    if (changed) this.syncFullscreenHeader();
    return changed;
  }

  override render(width: number): string[] {
    const gutter = this.options.fullscreen === true ? CHROME_GUTTER : 0;
    const panelWidth = Math.max(4, width - gutter * 2);
    const contentWidth = Math.max(1, panelWidth - 4);
    const body = this.fitBodyLines(this.getTurnLines(contentWidth));
    const { title } = this.buildTitle(body.truncated);
    const box = new Box({
      border: { top: true, left: true, right: true },
      borderStyle: 'rounded',
      borderColor: paintBorder,
      title,
      padding: { left: 1, right: 1 },
    });
    box.addChild({
      render: () => body.lines,
      invalidate: () => {},
    });
    const rendered = box.render(panelWidth);
    if (gutter === 0) return [...rendered];
    const pad = ' '.repeat(gutter);
    return rendered.map((line) => truncateToWidth(`${pad}${line}${pad}`, width));
  }

  private syncFullscreenHeader(): void {
    if (this.frameBox === undefined) return;
    if (this.rowEntryOptions !== undefined) {
      this.rowEntryOptions.maxSize = this.maxFullscreenPanelRows();
    }
    const truncated = this.bodyScroll?.canScroll ?? false;
    const { title, closeStart, closeEnd } = this.buildTitle(truncated);
    this.frameBox.updateHeader(title, closeStart, closeEnd);
  }

  private buildTitle(truncated: boolean): {
    readonly title: string;
    readonly closeStart: number;
    readonly closeEnd: number;
  } {
    const prefixPlain = ' BTW ─ ';
    const hint =
      truncated && this.options.canUseScrollKeys()
        ? `${CLOSE_LABEL} · ↑↓ scroll `
        : `${CLOSE_LABEL} `;
    const title =
      currentTheme.boldFg('accent', ' BTW ') +
      currentTheme.fg('border', '─ ') +
      currentTheme.fg('textMuted', hint);
    const closeStart = 1 + visibleWidth(prefixPlain);
    const closeEnd = closeStart + visibleWidth(CLOSE_LABEL);
    return { title, closeStart, closeEnd };
  }

  private resolveMinBodyRows(lineCount: number): number {
    const bodyLimit = this.collapsedBodyLimit();
    const targetUncapped = Math.max(this.minBodyLines, lineCount);
    const target = bodyLimit === undefined ? targetUncapped : Math.min(bodyLimit, targetUncapped);
    this.minBodyLines = Math.max(this.minBodyLines, target);
    return this.minBodyLines;
  }

  private renderUnclippedBody(width: number): readonly string[] {
    const lines = this.getTurnLines(width);
    const target = this.resolveMinBodyRows(lines.length);
    return padLines(lines, target);
  }

  private getTurnLines(width: number): readonly string[] {
    const safeWidth = Math.max(1, width);
    const cached = this.turnLinesCache;
    if (cached?.revision === this.contentRevision && cached.width === safeWidth) {
      return cached.lines;
    }
    const lines = this.collectTurnLines(safeWidth);
    this.turnLinesCache = { revision: this.contentRevision, width: safeWidth, lines };
    return lines;
  }

  private collectTurnLines(width: number): string[] {
    const lines: string[] = [];
    for (const [index, turn] of this.turns.entries()) {
      if (index > 0) lines.push('');
      lines.push(...this.renderTurn(turn, width));
    }
    if (this.turns.length === 0) {
      lines.push(currentTheme.fg('textDim', 'Ready for a side question…'));
    }
    for (const notice of this.transientNotices) {
      lines.push(...new Text(currentTheme.fg('textDim', notice), 0, 0).render(width));
    }
    return lines;
  }

  private fitBodyLines(lines: readonly string[]): BtwBodyRender {
    const target = this.resolveMinBodyRows(lines.length);

    if (lines.length > target) {
      this.maxScrollTop = lines.length - target;
      const following =
        this.bodyScroll !== undefined && this.bodyScroll.viewportHeight > 0
          ? this.bodyScroll.isFollowingEnd
          : this.followTail;
      const baseScrollTop =
        this.bodyScroll !== undefined && this.bodyScroll.viewportHeight > 0
          ? this.bodyScroll.scrollTop
          : this.scrollTop;
      if (following) {
        this.scrollTop = this.maxScrollTop;
      } else {
        this.scrollTop = Math.max(0, Math.min(baseScrollTop, this.maxScrollTop));
      }
      const start = this.scrollTop;
      return { lines: lines.slice(start, start + target), truncated: true };
    }

    this.followTail = true;
    this.scrollTop = 0;
    this.maxScrollTop = 0;
    return { lines: padLines(lines, target), truncated: false };
  }

  private maxFullscreenPanelRows(): number {
    const limit = this.collapsedBodyLimit();
    return limit === undefined ? Number.MAX_SAFE_INTEGER : limit + 1;
  }

  private collapsedBodyLimit(): number | undefined {
    const terminalRows = this.options.terminalRows();
    if (!Number.isFinite(terminalRows) || terminalRows <= 0) return undefined;
    const maxPanelLines = Math.max(MIN_COLLAPSED_PANEL_LINES, Math.floor(terminalRows / 3));
    return Math.max(1, maxPanelLines - 1);
  }

  private renderTurn(turn: BtwTurn, width: number): string[] {
    const prompt = currentTheme.fg('accent', `Q: ${turn.prompt}`);
    const lines = [...new Text(prompt, 0, 0).render(width)];
    const answer = turn.answer.trim();
    const thinking = turn.thinking.trim();
    if (answer.length > 0) {
      const theme: KimiMarkdownTheme =
        turn.phase === 'running'
          ? { ...this.options.markdownTheme, transient: true }
          : this.options.markdownTheme;
      lines.push(
        ...new Markdown(answer, 0, 0, theme, undefined, createMarkdownOptions()).render(width),
      );
    } else if (thinking.length > 0) {
      const thinkingLines = new Text(currentTheme.fg('textDim', thinking), 0, 0).render(width);
      const visibleThinking =
        thinkingLines.length > THINKING_PREVIEW_LINES
          ? thinkingLines.slice(thinkingLines.length - THINKING_PREVIEW_LINES)
          : thinkingLines;
      lines.push(...visibleThinking);
    } else if (turn.error === undefined) {
      lines.push(currentTheme.fg('textDim', 'Waiting for answer…'));
    }
    if (turn.error !== undefined) {
      const error = currentTheme.fg('error', turn.error);
      lines.push(...new Text(error, 0, 0).render(width));
    }
    return lines;
  }

  private currentTurn(): BtwTurn | undefined {
    return this.turns.at(-1);
  }

  isRunning(): boolean {
    return this.currentTurn()?.phase === 'running';
  }

  isEmpty(): boolean {
    return this.turns.length === 0;
  }

  scroll(direction: 'up' | 'down'): boolean {
    if (this.bodyScroll !== undefined) {
      const delta = direction === 'up' ? -1 : 1;
      const moved = this.bodyScroll.scrollBy(delta) !== delta;
      if (moved) {
        this.scrollTop = this.bodyScroll.scrollTop;
        this.followTail = this.bodyScroll.isFollowingEnd;
        this.syncFullscreenHeader();
      }
      return moved;
    }
    if (this.maxScrollTop <= 0) return false;
    const current = this.followTail ? this.maxScrollTop : this.scrollTop;
    const next =
      direction === 'up'
        ? Math.max(0, current - 1)
        : Math.min(this.maxScrollTop, current + 1);
    this.scrollTop = next;
    this.followTail = next === this.maxScrollTop;
    return true;
  }
}
