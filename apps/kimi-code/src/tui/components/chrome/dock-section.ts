import {
  ScrollView,
  VStack,
  type Component,
  type TuiMouseDispatchResult,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { CHROME_GUTTER } from '#/tui/constant/rendering';

import { GutterContainer } from './gutter-container';

export interface DockLayout {
  readonly maxBodyRows: number;
  readonly follow?: 'none' | 'end';
}

export type DockPart = 'head' | 'body' | 'foot';

export interface OverflowScrollViewOptions {
  readonly follow?: 'none' | 'end';
  readonly onScroll?: (scrollTop: number) => void;
  readonly onLayout?: () => void;
}

export class OverflowScrollView extends ScrollView {
  private overflowChanged = false;
  private lastContentHeight = 0;
  private readonly onLayout: (() => void) | undefined;

  constructor(component: Component, options: OverflowScrollViewOptions = {}) {
    super(component, {
      follow: options.follow,
      overscroll: 'contain',
      scrollbar: 'always',
      onScroll: options.onScroll,
    });
    this.onLayout = options.onLayout;
  }

  get measuredContentHeight(): number {
    return this.lastContentHeight;
  }

  override get isScrollbarVisible(): boolean {
    return this.canScroll;
  }

  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    const overflowed = this.canScroll;
    this.lastContentHeight = Math.max(0, Math.floor(contentHeight));
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    this.onLayout?.();
    if (this.canScroll !== overflowed) this.overflowChanged = true;
  }

  consumeOverflowChange(): boolean {
    if (!this.overflowChanged) return false;
    this.overflowChanged = false;
    return true;
  }
}

export function mouseTarget(component: Component, event: TuiMouseEvent): TuiMouseDispatchResult['target'] {
  return {
    component,
    originX: event.screenX - event.x,
    originY: event.screenY - event.y,
    width: event.width,
    height: event.height,
  };
}

export function createInteractiveChildView(
  owner: Component,
  render: (width: number) => string[],
  handleMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined,
): Component {
  const component: Component = {
    render,
    invalidate: () => {},
    handleMouse: (event) => {
      const result = handleMouse(event);
      if (result?.focus !== true) return result;
      return { ...result, handled: true, focusTarget: owner, target: mouseTarget(component, event) };
    },
  };
  return component;
}

export abstract class DockSection extends VStack {
  private readonly bodyScroll: OverflowScrollView | undefined;
  private pendingEnsureRange: { readonly start: number; readonly end: number } | undefined;

  constructor(readonly layout?: DockLayout) {
    super();
    const view = (part: DockPart): Component =>
      createInteractiveChildView(
        this,
        (width) => this.renderPart(part, width),
        (event) => {
          const result = this.handlePartMouse(part, event);
          if (result !== undefined) return result;
          if (part !== 'body' && this.bodyScroll !== undefined && event.type === 'wheel') {
            const delta = event.wheelDelta ?? 0;
            const moved = delta !== 0 && this.scrollBody(delta);
            return { handled: true, render: moved };
          }
          return undefined;
        },
      );
    if (layout === undefined) {
      this.addChild(view('head'));
      this.addChild(view('body'));
      this.addChild(view('foot'));
      return;
    }
    this.bodyScroll = new OverflowScrollView(padded(view('body')), {
      follow: layout.follow,
      onScroll: () => {
        this.onBodyScrolled();
      },
      onLayout: () => {
        const range = this.pendingEnsureRange;
        if (range === undefined) return;
        this.pendingEnsureRange = undefined;
        this.scrollRangeIntoView(range.start, range.end);
      },
    });
    this.addChild(padded(view('head')), { shrink: 0 });
    this.addChild(this.bodyScroll, { shrink: 1, minSize: 0, maxSize: layout.maxBodyRows });
    this.addChild(padded(view('foot')), { shrink: 0 });
  }

  scrollBody(lines: number): boolean {
    if (this.bodyScroll === undefined) return false;
    this.pendingEnsureRange = undefined;
    return this.bodyScroll.scrollBy(lines) !== lines;
  }

  protected ensureBodyVisible(startRow: number, endRow: number): void {
    if (this.bodyScroll === undefined) return;
    this.pendingEnsureRange = { start: startRow, end: endRow };
    this.scrollRangeIntoView(startRow, endRow);
  }

  private scrollRangeIntoView(startRow: number, endRow: number): void {
    const scroll = this.bodyScroll;
    if (scroll === undefined) return;
    const viewport = scroll.viewportHeight;
    if (viewport <= 0) return;
    if (startRow < scroll.scrollTop) {
      scroll.scrollTo(startRow);
    } else if (endRow > scroll.scrollTop + viewport) {
      scroll.scrollTo(Math.max(0, endRow - viewport));
    }
  }

  protected isBodyScrolledNearEnd(thresholdRows = 3): boolean {
    const scroll = this.bodyScroll;
    if (scroll === undefined || !scroll.canScroll) return false;
    return scroll.scrollTop + scroll.viewportHeight + thresholdRows >= scroll.measuredContentHeight;
  }

  protected bodyOverflows(partWidth: number): boolean {
    if (this.layout === undefined || this.bodyScroll === undefined) return false;
    return (
      this.bodyScroll.canScroll ||
      this.renderPart('body', Math.max(1, partWidth - 1)).length > this.layout.maxBodyRows
    );
  }

  scrollBodyToTop(): void {
    this.pendingEnsureRange = undefined;
    this.bodyScroll?.scrollToStart();
  }

  consumeOverflowChange(): boolean {
    return this.bodyScroll?.consumeOverflowChange() ?? false;
  }

  protected onBodyScrolled(): void {}

  protected abstract renderPart(part: DockPart, width: number): string[];

  protected handlePartMouse(_part: DockPart, _event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return undefined;
  }
}

function padded(component: Component): GutterContainer {
  const gutter = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  gutter.addChild(component);
  return gutter;
}
