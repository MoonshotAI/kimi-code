/**
 * DockSection — a panel made of a fixed head, a body and a fixed foot.
 *
 * Inline (regular mode, no `DockLayout`) the three parts simply stack and the
 * host's GutterContainer pads them. Docked (fullscreen) the section sits in
 * the layout tree itself: each part carries its own gutter, the body lives in
 * a ScrollView capped at `maxBodyRows` and scrolls with the wheel, and the
 * head and foot never shrink — so a long body cannot push the foot (options,
 * key hints) off the screen. A part that takes focus on a click hands it to
 * the whole section.
 */

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

/**
 * Keeps the scrollbar column reserved but paints the bar only while the body
 * overflows, so a short body shows no track and a long one always shows where
 * it is.
 */
class OverflowScrollView extends ScrollView {
  override get isScrollbarVisible(): boolean {
    return this.canScroll;
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    // Consume the wheel here so the renderer's fallback cannot hand overscroll to the transcript.
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
  private readonly bodyScroll: ScrollView | undefined;

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

  /** Scroll a docked body by `lines`; false when it did not move (inline, or already at the edge). */
  scrollBody(lines: number): boolean {
    if (this.bodyScroll === undefined) return false;
    return this.bodyScroll.scrollBy(lines) !== lines;
  }

  /**
   * Whether a docked body is taller than its rows, judged from a head or foot
   * render at `partWidth`: the body renders one column narrower (the
   * scrollbar's), and the last layout covers a dock squeezed below the cap.
   */
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
