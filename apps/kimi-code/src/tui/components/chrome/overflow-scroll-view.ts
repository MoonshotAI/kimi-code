import {
  ScrollView,
  type Component,
  type ScrollViewOptions,
  type TuiMouseDispatchResult,
  type TuiMouseEvent,
} from '@moonshot-ai/pi-tui';

export interface OverflowScrollViewOptions extends ScrollViewOptions {
  readonly scrollbarEnabled?: boolean;
  readonly deferOverflowRender?: boolean;
  readonly onWheel?: () => void;
}

export class OverflowScrollView extends ScrollView {
  private scrollbarEnabled: boolean;
  private readonly deferOverflowRender: boolean;
  private readonly onWheel: (() => void) | undefined;
  private overflowChanged = false;

  constructor(child: Component, options: OverflowScrollViewOptions = {}) {
    super(child, {
      overscroll: 'contain',
      scrollbar: 'always',
      ...options,
    });
    this.scrollbarEnabled = options.scrollbarEnabled ?? true;
    this.deferOverflowRender = options.deferOverflowRender ?? false;
    this.onWheel = options.onWheel;
  }

  get measuredContentHeight(): number {
    return this.contentHeight;
  }

  setScrollbarEnabled(enabled: boolean): void {
    this.scrollbarEnabled = enabled;
  }

  override get isScrollbarVisible(): boolean {
    return this.scrollbarEnabled && this.canScroll;
  }

  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    const overflowed = this.canScroll;
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    if (this.canScroll !== overflowed) {
      if (this.deferOverflowRender) this.overflowChanged = true;
      else requestRender();
    }
  }

  consumeOverflowChange(): boolean {
    if (!this.overflowChanged) return false;
    this.overflowChanged = false;
    return true;
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    if (this.onWheel === undefined || event.type !== 'wheel') return undefined;
    this.scrollBy(event.wheelDelta ?? 0);
    this.onWheel();
    return {
      handled: true,
      target: {
        component: this,
        originX: event.screenX - event.x,
        originY: event.screenY - event.y,
        width: event.width,
        height: event.height,
      },
    };
  }
}
