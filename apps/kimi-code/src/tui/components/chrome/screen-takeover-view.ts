import {
  HStack,
  Key,
  ScrollView,
  VStack,
  matchesKey,
  renderLayoutFrame,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type Terminal,
  type TuiMouseDispatchResult,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { currentTheme } from '#/tui/theme';
import {
  SpanHitMap,
  focusOnUnfocusedClick,
  renderInlineSegments,
  type InlineSegment,
} from '#/tui/utils/mouse-regions';
import { printableChar } from '#/tui/utils/printable-key';

import { OverflowScrollView } from './overflow-scroll-view';

const ELLIPSIS = '…';

function mouseTarget(component: Component, event: TuiMouseEvent): TuiMouseDispatchResult['target'] {
  return {
    component,
    originX: event.screenX - event.x,
    originY: event.screenY - event.y,
    width: event.width,
    height: event.height,
  };
}

export function fitLineExactly(line: string, width: number): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return '';
  const w = visibleWidth(line);
  if (w === safeWidth) return line;
  if (w > safeWidth) {
    const truncated = truncateToWidth(line, safeWidth, ELLIPSIS);
    const tw = visibleWidth(truncated);
    return tw < safeWidth ? truncated + ' '.repeat(safeWidth - tw) : truncated;
  }
  return line + ' '.repeat(safeWidth - w);
}

export function formatScrollPosition(scrollView: ScrollView): string {
  const total = scrollView.contentHeight;
  const viewRows = Math.max(1, scrollView.viewportHeight);
  const maxScroll = Math.max(0, total - viewRows);
  const scrollTop = Math.min(scrollView.scrollTop, maxScroll);
  const percent = maxScroll === 0 ? 100 : Math.round((scrollTop / maxScroll) * 100);
  const lineFrom = total === 0 ? 0 : scrollTop + 1;
  const lineTo = Math.min(total, scrollTop + viewRows);
  return ` ${String(lineFrom)}-${String(lineTo)} / ${String(total)} (${String(percent)}%) `;
}

export interface FooterHintItem<T = never> {
  readonly key: string;
  readonly label: string;
  readonly action?: T;
}

export function renderViewerFooter<T>(
  width: number,
  segments: readonly InlineSegment<T>[],
  rightText: string,
  hitMap: SpanHitMap<T>,
): string {
  const safeWidth = Math.max(0, Math.floor(width));
  const { line, targets } = renderInlineSegments(segments, safeWidth);
  hitMap.reset();
  hitMap.addRow(0, targets);
  if (rightText.length > 0) {
    const rightStyled = currentTheme.fg('textMuted', rightText);
    const leftW = visibleWidth(line);
    const rightW = visibleWidth(rightStyled);
    if (leftW + 2 + rightW <= safeWidth) {
      return line + ' '.repeat(safeWidth - leftW - rightW) + rightStyled;
    }
  }
  return fitLineExactly(line, safeWidth);
}

export function renderFooterHints<T>(
  width: number,
  items: readonly FooterHintItem<T>[],
  scrollView: ScrollView,
  hitMap: SpanHitMap<T>,
): string {
  const segments: InlineSegment<T>[] = [{ text: ' ' }];
  for (let i = 0; i < items.length; i++) {
    if (i > 0) segments.push({ text: '  ' });
    const item = items[i]!;
    const text = `${currentTheme.boldFg('primary', item.key)} ${currentTheme.fg('textMuted', item.label)}`;
    segments.push(item.action === undefined ? { text } : { text, value: item.action });
  }
  return renderViewerFooter(width, segments, formatScrollPosition(scrollView), hitMap);
}

export function scrollFooterHints<T>(
  pageKey: string,
  closeKey: string,
  closeAction: T,
  extra?: readonly FooterHintItem<T>[],
): readonly FooterHintItem<T>[] {
  return [
    { key: '↑↓', label: 'line' },
    { key: pageKey, label: 'page' },
    { key: 'g/G', label: 'top/bot' },
    ...(extra ?? []),
    { key: closeKey, label: 'cancel', action: closeAction },
  ];
}

function applyScrollKey(scrollView: ScrollView, data: string): boolean {
  const key = printableChar(data);
  if (matchesKey(data, Key.up) || key === 'k') {
    scrollView.scrollBy(-1);
    return true;
  }
  if (matchesKey(data, Key.down) || key === 'j') {
    scrollView.scrollBy(1);
    return true;
  }
  if (
    matchesKey(data, Key.pageUp) ||
    matchesKey(data, Key.ctrl('u')) ||
    matchesKey(data, Key.ctrl('b')) ||
    key === ' ' ||
    key === 'b'
  ) {
    scrollView.scrollPage(-1, 1);
    return true;
  }
  if (
    matchesKey(data, Key.pageDown) ||
    matchesKey(data, Key.ctrl('d')) ||
    matchesKey(data, Key.ctrl('f'))
  ) {
    scrollView.scrollPage(1, 1);
    return true;
  }
  if (matchesKey(data, Key.home) || key === 'g') {
    scrollView.scrollToStart();
    return true;
  }
  if (matchesKey(data, Key.end) || key === 'G') {
    scrollView.scrollToEnd();
    return true;
  }
  return false;
}

export interface ScrollViewerKeyOptions {
  readonly onClose: () => void;
  readonly onExtraKey?: (data: string) => boolean;
}

export function handleScrollViewerKey(
  scrollView: ScrollView,
  data: string,
  options: ScrollViewerKeyOptions,
): boolean {
  const key = printableChar(data);
  if (matchesKey(data, Key.escape) || key === 'q' || key === 'Q') {
    options.onClose();
    return true;
  }
  if (options.onExtraKey?.(data) === true) return true;
  return applyScrollKey(scrollView, data);
}

export interface FramedScrollPaneOptions {
  readonly padX: 0 | 1;
  readonly follow?: 'none' | 'end';
  readonly initialPosition?: 'start' | 'end';
  readonly primary?: boolean;
  readonly title?: () => string;
  readonly borderColor?: () => string;
  readonly maxRows?: () => number;
  readonly renderContent: (width: number) => string[];
  readonly handleContentMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
  readonly onFocusTarget?: () => (Component & Focusable) | undefined;
}

export class FramedScrollPane extends VStack {
  readonly scrollView: ScrollView;
  private readonly overflowScrollView: OverflowScrollView | undefined;
  private maxRowsProvider: (() => number) | undefined;
  private focusTargetProvider: (() => (Component & Focusable) | undefined) | undefined;

  constructor(private readonly options: FramedScrollPaneOptions) {
    super();
    this.maxRowsProvider = options.maxRows;
    this.focusTargetProvider = options.onFocusTarget;

    const paintBorder = (text: string): string => {
      const hex = this.options.borderColor?.() ?? currentTheme.palette.border;
      return chalk.hex(hex)(text);
    };

    const topBorder: Component = {
      render: (width) => [this.renderTopBorder(width, paintBorder)],
      invalidate: () => {},
    };

    const bottomBorder: Component = {
      render: (width) => {
        const safeWidth = Math.max(0, Math.floor(width));
        if (safeWidth < 2) return [' '.repeat(safeWidth)];
        return [paintBorder('╰' + '─'.repeat(safeWidth - 2) + '╯')];
      },
      invalidate: () => {},
    };

    const railRowCount = (): number =>
      Math.max(1, this.scrollView.viewportHeight, this.maxRowsProvider?.() ?? 0);

    const leftRailWidth = options.padX === 1 ? 2 : 1;
    const leftRail: Component = {
      render: () => {
        const cell = options.padX === 1 ? `${paintBorder('│')} ` : paintBorder('│');
        return Array.from({ length: railRowCount() }, () => cell);
      },
      invalidate: () => {},
    };

    const rightRail: Component = {
      render: () => {
        const cell = paintBorder('│');
        return Array.from({ length: railRowCount() }, () => cell);
      },
      invalidate: () => {},
    };

    const bodyContent: Component = {
      render: (width) => this.options.renderContent(width),
      invalidate: () => {},
      handleMouse: (event) => {
        const focusTarget = this.focusTargetProvider?.();
        const result =
          this.options.handleContentMouse?.(event) ??
          (focusTarget === undefined ? undefined : focusOnUnfocusedClick(focusTarget.focused, event));
        if (result?.focus !== true || focusTarget === undefined) return result;
        return {
          ...result,
          handled: true,
          focusTarget,
          target: mouseTarget(bodyContent, event),
        };
      },
    };

    const commonScrollOptions = {
      follow: options.follow ?? 'none',
      ...(options.initialPosition === undefined ? {} : { initialPosition: options.initialPosition }),
      primary: options.primary ?? false,
      overscroll: 'contain' as const,
      scrollbarTrackStyle: (text: string) => currentTheme.fg('border', text),
      scrollbarThumbStyle: (text: string) => currentTheme.fg('textMuted', text),
    };

    if (options.padX === 1) {
      this.overflowScrollView = new OverflowScrollView(bodyContent, {
        ...commonScrollOptions,
        scrollbar: 'always',
        scrollbarEnabled: false,
      });
      this.scrollView = this.overflowScrollView;
    } else {
      this.scrollView = new ScrollView(bodyContent, {
        ...commonScrollOptions,
        scrollbar: 'hidden',
      });
    }

    const bodyHStack = new HStack([], { align: 'stretch' });
    bodyHStack.addChild(leftRail, { basis: leftRailWidth, shrink: 0 });
    bodyHStack.addChild(this.scrollView, { basis: 0, grow: 1, shrink: 1, minSize: 0 });
    bodyHStack.addChild(rightRail, { basis: 1, shrink: 0 });

    this.addChild(topBorder, { basis: 1, shrink: 0 });
    this.addChild(bodyHStack, { basis: 0, grow: 1, shrink: 1, minSize: 0 });
    this.addChild(bottomBorder, { basis: 1, shrink: 0 });
  }

  setMaxRowsProvider(provider: () => number): void {
    if (this.maxRowsProvider === undefined) this.maxRowsProvider = provider;
  }

  setFocusTarget(provider: () => (Component & Focusable) | undefined): void {
    if (this.focusTargetProvider === undefined) this.focusTargetProvider = provider;
  }

  setScrollbarActive(active: boolean): void {
    if (this.overflowScrollView !== undefined) {
      this.overflowScrollView.setScrollbarEnabled(active);
      if (!active) this.overflowScrollView.setScrollbarActive(false);
      return;
    }
    if (!active) this.scrollView.setScrollbarActive(false);
    this.scrollView.setScrollbar(active ? 'auto' : 'hidden');
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    if (event.type === 'wheel') return undefined;
    const focusTarget = this.focusTargetProvider?.();
    if (focusTarget === undefined || focusTarget.focused) return undefined;
    const result = focusOnUnfocusedClick(false, event);
    if (result === undefined) return undefined;
    return {
      ...result,
      handled: true,
      ...(result.focus === true ? { focusTarget } : {}),
      target: mouseTarget(this, event),
    };
  }

  private renderTopBorder(width: number, paintBorder: (text: string) => string): string {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth < 2) return ' '.repeat(safeWidth);
    const innerWidth = safeWidth - 2;
    const title = this.options.title?.() ?? '';
    if (title.length > 0) {
      const titleStyled = currentTheme.boldFg('textStrong', title);
      const segmentWidth = visibleWidth(`─ ${titleStyled} `);
      if (segmentWidth <= innerWidth) {
        const dashes = '─'.repeat(Math.max(0, innerWidth - segmentWidth));
        return paintBorder('╭─ ') + titleStyled + ' ' + paintBorder(`${dashes}╮`);
      }
    }
    return paintBorder('╭' + '─'.repeat(innerWidth) + '╮');
  }
}

export interface ScreenTakeoverViewOptions {
  readonly minRows?: number;
}

export interface SinglePaneMountOptions<T> {
  readonly follow?: 'none' | 'end';
  readonly initialPosition?: 'start' | 'end';
  readonly renderHeader: (width: number) => string;
  readonly renderContent: (width: number) => string[];
  readonly footerHints: () => readonly FooterHintItem<T>[];
  readonly onFooterAction: (action: T) => void;
}

export class ScreenTakeoverView extends VStack implements Focusable {
  focused = false;
  private readonly minRows: number;
  private readonly panes: FramedScrollPane[] = [];
  private scrollbarsActive = false;

  constructor(
    protected readonly terminal: Terminal,
    options?: ScreenTakeoverViewOptions,
  ) {
    super();
    this.minRows = Math.max(1, Math.floor(options?.minRows ?? 3));
  }

  protected registerPane(pane: FramedScrollPane): FramedScrollPane {
    pane.setMaxRowsProvider(() => this.frameRows());
    pane.setFocusTarget(() => this);
    pane.setScrollbarActive(this.scrollbarsActive);
    this.panes.push(pane);
    return pane;
  }

  protected mountSinglePane<T>(options: SinglePaneMountOptions<T>): FramedScrollPane {
    const footerHits = new SpanHitMap<T>();
    const pane = this.registerPane(
      new FramedScrollPane({
        padX: 1,
        ...(options.follow === undefined ? {} : { follow: options.follow }),
        ...(options.initialPosition === undefined
          ? {}
          : { initialPosition: options.initialPosition }),
        primary: true,
        borderColor: () => currentTheme.palette.primary,
        renderContent: options.renderContent,
      }),
    );

    this.addChild(this.ownedView((width) => [options.renderHeader(width)]), {
      basis: 1,
      shrink: 0,
    });
    this.addChild(pane, { basis: 0, grow: 1, shrink: 1, minSize: 0 });
    this.addChild(
      this.ownedView(
        (width) => [renderFooterHints(width, options.footerHints(), pane.scrollView, footerHits)],
        (event) =>
          footerHits.handle(event, {
            focused: this.focused,
            onActivate: (action) => options.onFooterAction(action),
          }),
      ),
      { basis: 1, shrink: 0 },
    );
    return pane;
  }

  setScrollbarsActive(active: boolean): void {
    this.scrollbarsActive = active;
    for (const pane of this.panes) pane.setScrollbarActive(active);
  }

  protected frameRows(): number {
    return Math.max(this.minRows, this.terminal.rows);
  }

  protected ownedView(
    render: (width: number) => string[],
    handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined,
  ): Component {
    const component: Component = {
      render,
      invalidate: () => {},
      handleMouse: (event) => {
        const result = handleMouse?.(event) ?? focusOnUnfocusedClick(this.focused, event);
        if (result?.focus !== true) return result;
        return {
          ...result,
          handled: true,
          focusTarget: this,
          target: mouseTarget(component, event),
        };
      },
    };
    return component;
  }

  override render(width: number): string[] {
    return renderLayoutFrame(
      this,
      Math.max(1, width),
      this.frameRows(),
      () => this.invalidate(),
    ).lines;
  }
}
