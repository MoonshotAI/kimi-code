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
}

export type DockPart = 'head' | 'body' | 'foot';

class OverflowScrollView extends ScrollView {
  private overflowChanged = false;

  override get isScrollbarVisible(): boolean {
    return this.canScroll;
  }

  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    const overflowed = this.canScroll;
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    if (this.canScroll !== overflowed) this.overflowChanged = true;
  }

  consumeOverflowChange(): boolean {
    if (!this.overflowChanged) return false;
    this.overflowChanged = false;
    return true;
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    if (event.type !== 'wheel') return undefined;
    this.scrollBy(event.wheelDelta ?? 0);
    return { handled: true, target: mouseTarget(this, event) };
  }
}

function mouseTarget(component: Component, event: TuiMouseEvent): TuiMouseDispatchResult['target'] {
  return {
    component,
    originX: event.screenX - event.x,
    originY: event.screenY - event.y,
    width: event.width,
    height: event.height,
  };
}

export abstract class DockSection extends VStack {
  private readonly bodyScroll: OverflowScrollView | undefined;

  constructor(readonly layout?: DockLayout) {
    super();
    const view = (part: DockPart): Component => {
      const component: Component = {
        render: (width) => this.renderPart(part, width),
        invalidate: () => {},
        handleMouse: (event) => {
          const result = this.handlePartMouse(part, event);
          if (result?.focus !== true) return result;
          return { ...result, handled: true, focusTarget: this, target: mouseTarget(component, event) };
        },
      };
      return component;
    };
    if (layout === undefined) {
      this.addChild(view('head'));
      this.addChild(view('body'));
      this.addChild(view('foot'));
      return;
    }
    this.bodyScroll = new OverflowScrollView(padded(view('body')), {
      overscroll: 'contain',
      scrollbar: 'always',
    });
    this.addChild(padded(view('head')), { shrink: 0 });
    this.addChild(this.bodyScroll, { shrink: 1, minSize: 0, maxSize: layout.maxBodyRows });
    this.addChild(padded(view('foot')), { shrink: 0 });
  }

  scrollBody(lines: number): boolean {
    if (this.bodyScroll === undefined) return false;
    return this.bodyScroll.scrollBy(lines) !== lines;
  }

  protected bodyOverflows(partWidth: number): boolean {
    if (this.layout === undefined || this.bodyScroll === undefined) return false;
    return (
      this.bodyScroll.canScroll ||
      this.renderPart('body', Math.max(1, partWidth - 1)).length > this.layout.maxBodyRows
    );
  }

  scrollBodyToTop(): void {
    this.bodyScroll?.scrollToStart();
  }

  consumeOverflowChange(): boolean {
    return this.bodyScroll?.consumeOverflowChange() ?? false;
  }

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
