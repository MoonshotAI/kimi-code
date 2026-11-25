import {
  HStack,
  Text,
  VStack,
  renderLayoutFrame,
  truncateToWidth,
  visibleWidth,
  type Component,
  type MarkdownTheme,
} from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { OverflowScrollView } from '#/tui/components/chrome/overflow-scroll-view';
import { Markdown } from '#/tui/components/markdown/markdown';
import { THINKING_PREVIEW_LINES } from '#/tui/constant/rendering';
import { currentTheme, type ColorPalette } from '#/tui/theme';
import type { KimiMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import type { InlineSkillActivation } from '#/tui/types';
import { createMarkdownOptions } from '#/tui/utils/markdown-options';
import {
  SpanHitMap,
  renderInlineSegments,
  type InlineSegment,
} from '#/tui/utils/mouse-regions';

type BtwPanelPhase = 'running' | 'done' | 'failed';

const MIN_COLLAPSED_PANEL_LINES = 3;

interface BtwTurn {
  readonly prompt: string;
  answer: string;
  thinking: string;
  error?: string;
  phase: BtwPanelPhase;
}

interface BodyRenderCache {
  readonly contentWidth: number;
  readonly version: number;
  readonly palette: ColorPalette;
  readonly lines: string[];
}

class BtwScrollView extends OverflowScrollView {
  private directRender = false;
  private managedByLayout = false;

  constructor(
    child: Component,
    private readonly scrollbarInLayout: boolean,
  ) {
    super(child, {
      follow: 'end',
      overscroll: 'contain',
      scrollbar: scrollbarInLayout ? 'always' : 'hidden',
      scrollbarEnabled: scrollbarInLayout,
    });
  }

  get isManagedByLayout(): boolean {
    return this.managedByLayout;
  }

  runDirectRender<T>(fn: () => T): T {
    this.directRender = true;
    this.setScrollbarEnabled(false);
    try {
      return fn();
    } finally {
      this.directRender = false;
      this.setScrollbarEnabled(this.scrollbarInLayout);
    }
  }

  override updateLayout(
    contentHeight: number,
    viewportHeight: number,
    requestRender: () => void,
  ): void {
    if (this.directRender) {
      if (this.managedByLayout) return;
      super.updateLayout(contentHeight, viewportHeight, requestRender);
      return;
    }
    this.managedByLayout = true;
    super.updateLayout(contentHeight, viewportHeight, requestRender);
  }
}

export interface BtwPanelOptions {
  readonly markdownTheme: MarkdownTheme;
  readonly canUseScrollKeys: () => boolean;
  readonly onPrompt: (
    prompt: string,
    inlineSkillActivations?: readonly InlineSkillActivation[],
  ) => void;
  readonly terminalRows: () => number;
  readonly gutter?: number;
  readonly onClose?: () => void;
}

export class BtwPanelComponent extends VStack {
  private readonly turns: BtwTurn[] = [];
  private readonly transientNotices: string[] = [];
  private readonly gutter: number;
  private readonly leftRailWidth: number;
  private readonly rightRailWidth: number;
  private readonly scrollView: BtwScrollView;
  private readonly topBorderHits = new SpanHitMap<'close'>();
  private minBodyLines = 0;
  private currentBodyRows = 1;
  private bodyTruncated = false;
  private renderVersion = 0;
  private bodyCache: BodyRenderCache | undefined;

  constructor(private readonly options: BtwPanelOptions) {
    super();
    this.gutter = Math.max(0, Math.floor(options.gutter ?? 0));
    this.leftRailWidth = this.gutter > 0 ? this.gutter + 2 : 2;
    this.rightRailWidth = this.gutter > 0 ? this.gutter + 1 : 2;

    const topBorder: Component = {
      render: (width) => [this.renderTopBorder(width)],
      invalidate: () => {},
      handleMouse: (event) => {
        if (this.options.onClose === undefined) return undefined;
        return this.topBorderHits.handle(event, {
          onActivate: () => {
            this.options.onClose?.();
          },
        });
      },
    };

    const pad = ' '.repeat(this.gutter);
    const leftRail: Component = {
      render: () => {
        const cell = `${pad}${chalk.hex(currentTheme.palette.border)('│')} `;
        return Array.from({ length: this.currentBodyRows }, () => cell);
      },
      invalidate: () => {},
    };

    const bodyContent: Component = {
      render: (width) => this.renderBodyLines(width),
      invalidate: () => {},
    };

    this.scrollView = new BtwScrollView(bodyContent, this.gutter > 0);

    const rightRail: Component = {
      render: () => {
        const border = chalk.hex(currentTheme.palette.border)('│');
        const cell = this.gutter > 0 ? `${border}${pad}` : ` ${border}`;
        return Array.from({ length: this.currentBodyRows }, () => cell);
      },
      invalidate: () => {},
    };

    const bodyHStack = new HStack([], { align: 'stretch' });
    bodyHStack.addChild(leftRail, { basis: this.leftRailWidth, shrink: 0 });
    bodyHStack.addChild(this.scrollView, { basis: 0, grow: 1, shrink: 1, minSize: 0 });
    bodyHStack.addChild(rightRail, { basis: this.rightRailWidth, shrink: 0 });

    this.addChild(topBorder, { basis: 1, shrink: 0 });
    this.addChild(bodyHStack, { basis: 0, grow: 1, shrink: 1, minSize: 0 });
  }

  submit(prompt: string, inlineSkillActivations?: readonly InlineSkillActivation[]): void {
    const normalized = prompt.trim();
    if (normalized.length === 0 || this.isRunning()) return;
    this.transientNotices.length = 0;
    this.turns.push({
      prompt: normalized,
      answer: '',
      thinking: '',
      phase: 'running',
    });
    this.markDirty();
    this.scrollView.scrollToEnd();
    this.options.onPrompt(normalized, inlineSkillActivations);
  }

  addTransientNotice(message: string): void {
    this.transientNotices.push(message);
    this.markDirty();
    this.scrollView.scrollToEnd();
  }

  appendAnswer(delta: string): void {
    const turn = this.currentTurn();
    if (turn === undefined) return;
    turn.answer += delta;
    this.markDirty();
  }

  appendThinking(delta: string): void {
    const turn = this.currentTurn();
    if (turn === undefined) return;
    turn.thinking += delta;
    this.markDirty();
  }

  markDone(resultSummary?: string): void {
    const turn = this.currentTurn();
    if (turn === undefined) return;
    if (turn.answer.trim().length === 0 && resultSummary !== undefined) {
      turn.answer = resultSummary;
    }
    this.transientNotices.length = 0;
    turn.phase = 'done';
    this.markDirty();
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
      this.markDirty();
      return;
    }
    turn.error = error;
    this.transientNotices.length = 0;
    turn.phase = 'failed';
    this.markDirty();
  }

  override invalidate(): void {
    this.bodyCache = undefined;
    super.invalidate();
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(4, width);
    const targetBodyLines = this.prepareBody(safeWidth);
    return this.scrollView.runDirectRender(
      () => renderLayoutFrame(this, safeWidth, 1 + targetBodyLines, () => this.invalidate()).lines,
    );
  }

  private markDirty(): void {
    this.renderVersion += 1;
    this.bodyCache = undefined;
  }

  private contentWidthFor(panelWidth: number): number {
    const scrollWidth = Math.max(1, panelWidth - this.leftRailWidth - this.rightRailWidth);
    return this.scrollView.getContentWidth(scrollWidth);
  }

  private prepareBody(panelWidth: number): number {
    const contentWidth = this.contentWidthFor(panelWidth);
    const lines = this.renderBodyLines(contentWidth);
    const bodyLimit = this.collapsedBodyLimit();
    const targetUncapped = Math.max(this.minBodyLines, lines.length);
    const target =
      bodyLimit === undefined ? targetUncapped : Math.min(bodyLimit, targetUncapped);
    this.minBodyLines = Math.max(this.minBodyLines, target);
    this.currentBodyRows = target;
    this.bodyTruncated = lines.length > target;
    return target;
  }

  private renderTopBorder(width: number): string {
    const safeWidth = Math.max(4, width);
    this.prepareBody(safeWidth);
    const paint = (s: string): string => chalk.hex(currentTheme.palette.border)(s);
    const muted = (s: string): string => chalk.hex(currentTheme.palette.textMuted)(s);
    const pad = ' '.repeat(this.gutter);
    const truncated =
      this.bodyTruncated || (this.scrollView.isManagedByLayout && this.scrollView.canScroll);
    const showScrollHint = truncated && this.options.canUseScrollKeys();
    const innerWidth = Math.max(0, safeWidth - this.gutter * 2 - 2);
    const maxLeftWidth = Math.min(safeWidth, this.gutter + 1 + innerWidth);
    const segments: InlineSegment<'close'>[] = [
      ...(this.gutter > 0 ? [{ text: pad }] : []),
      { text: paint('╭') },
      { text: chalk.hex(currentTheme.palette.accent).bold(' BTW ') },
      { text: paint('─ ') },
      {
        text: muted('Esc close'),
        ...(this.options.onClose === undefined ? {} : { value: 'close' as const }),
      },
      { text: muted(showScrollHint ? ' · ↑↓ scroll ' : ' ') },
    ];
    const { line: leftLine, targets } = renderInlineSegments(segments, maxLeftWidth);
    this.topBorderHits.reset();
    this.topBorderHits.addRow(0, targets);
    const dashCount = Math.max(0, maxLeftWidth - visibleWidth(leftLine));
    return leftLine + paint('─'.repeat(dashCount)) + paint('╮') + pad;
  }

  private renderBodyLines(width: number): string[] {
    const contentWidth = Math.max(1, width);
    const palette = currentTheme.palette;
    const cached = this.bodyCache;
    if (
      cached !== undefined &&
      cached.contentWidth === contentWidth &&
      cached.version === this.renderVersion &&
      cached.palette === palette
    ) {
      return cached.lines;
    }
    const raw: string[] = [];
    for (const [index, turn] of this.turns.entries()) {
      if (index > 0) raw.push('');
      raw.push(...this.renderTurn(turn, contentWidth));
    }
    if (this.turns.length === 0) {
      raw.push(chalk.hex(palette.textDim)('Ready for a side question…'));
    }
    raw.push(...this.renderTransientNotices(contentWidth));
    const lines = raw.map((line) =>
      visibleWidth(line) > contentWidth ? truncateToWidth(line, contentWidth, '…') : line,
    );
    this.bodyCache = { contentWidth, version: this.renderVersion, palette, lines };
    return lines;
  }

  private renderTransientNotices(width: number): string[] {
    const lines: string[] = [];
    for (const notice of this.transientNotices) {
      lines.push(...new Text(chalk.hex(currentTheme.palette.textDim)(notice), 0, 0).render(width));
    }
    return lines;
  }

  private collapsedBodyLimit(): number | undefined {
    const terminalRows = this.options.terminalRows();
    if (!Number.isFinite(terminalRows) || terminalRows <= 0) return undefined;
    const maxPanelLines = Math.max(MIN_COLLAPSED_PANEL_LINES, Math.floor(terminalRows / 3));
    return Math.max(1, maxPanelLines - 1);
  }

  private renderTurn(turn: BtwTurn, width: number): string[] {
    const prompt = chalk.hex(currentTheme.palette.accent)(`Q: ${turn.prompt}`);
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
      const thinkingLines = new Text(chalk.hex(currentTheme.palette.textDim)(thinking), 0, 0).render(
        width,
      );
      const visibleThinking =
        thinkingLines.length > THINKING_PREVIEW_LINES
          ? thinkingLines.slice(thinkingLines.length - THINKING_PREVIEW_LINES)
          : thinkingLines;
      lines.push(...visibleThinking);
    } else if (turn.error === undefined) {
      lines.push(chalk.hex(currentTheme.palette.textDim)('Waiting for answer…'));
    }
    if (turn.error !== undefined) {
      const error = chalk.hex(currentTheme.palette.error)(turn.error);
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
    if (!this.scrollView.canScroll) return false;
    this.scrollView.scrollBy(direction === 'up' ? -1 : 1);
    return true;
  }
}
