/**
 * Container that reserves left/right gutter columns around its children,
 * so the chrome (statusline, transcript, panels) lines up with the input
 * box's inner content area instead of butting up against the terminal edge.
 *
 * Children are rendered at `width - left - right` and each emitted line is
 * prefixed with `left` plain spaces. Right padding is logical only — we
 * never emit trailing spaces, since terminals already paint background to
 * the edge and adding them would just churn the diff renderer.
 *
 * The render cache below validates per child (component identity + the
 * identity of its rendered line array), so structural child-list changes —
 * append, splice-removal, in-place replacement — are picked up correctly
 * without a tree-wide `invalidate()`. Reserve `invalidate()` for global
 * style changes that genuinely dirty every child (e.g. theme switches).
 */

import { Container } from '@moonshot-ai/pi-tui';
import type {
  Component,
  TuiMouseDispatchResult,
  TuiMouseEvent,
  TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { prefixPreservingOsc133Zone } from '#/tui/utils/osc133';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

interface TranscriptRenderCache {
  width: number;
  childRefs: Component[];
  childRenderRefs: string[][];
  prefixed: string[][];
  out: string[];
}

export class GutterContainer extends Container {
  private renderCache: TranscriptRenderCache | undefined;
  private unhandledClick: ((index: number) => TuiMouseEventResult | undefined) | undefined;

  setUnhandledClick(handler: (index: number) => TuiMouseEventResult | undefined): void {
    this.unhandledClick = handler;
  }

  constructor(
    private readonly leftPad: number,
    private readonly rightPad: number,
  ) {
    super();
  }

  override invalidate(): void {
    this.renderCache = undefined;
    super.invalidate();
  }

  override render(width: number): string[] {
    const inner = Math.max(1, width - this.leftPad - this.rightPad);
    const lead = ' '.repeat(this.leftPad);

    const cache = this.renderCache;
    const cacheValid =
      isRenderCacheEnabled() &&
      cache !== undefined &&
      cache.width === width &&
      cache.childRefs.length === this.children.length;

    const childRefs: Component[] = [];
    const childRenderRefs: string[][] = [];
    const prefixed: string[][] = [];
    let allReused = cacheValid;

    let i = 0;
    for (const child of this.children) {
      const lines = child.render(inner);
      childRefs.push(child);
      childRenderRefs.push(lines);
      const reused = cacheValid && cache.childRefs[i] === child && cache.childRenderRefs[i] === lines;
      if (reused) {
        prefixed.push(cache.prefixed[i]!);
      } else {
        allReused = false;
        // OSC 133 zone markers must stay at byte 0 for the fullscreen
        // renderer's prompt navigation, so the gutter goes after them.
        prefixed.push(lines.map((line) => prefixPreservingOsc133Zone(line, lead)));
      }
      i++;
    }

    let out: string[];
    if (allReused) {
      out = cache!.out;
    } else {
      out = [];
      for (const lines of prefixed) {
        for (const line of lines) out.push(line);
      }
    }

    if (isRenderCacheEnabled()) {
      this.renderCache = { width, childRefs, childRenderRefs, prefixed, out };
    }

    return out;
  }

  // Mouse events arrive in this container's frame, which includes the
  // gutters; children render at the shrunk inner width after the left pad,
  // so translate before delegating or clicks land a gutter-width off.
  override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    const inner = Math.max(1, event.width - this.leftPad - this.rightPad);
    const adjusted: TuiMouseEvent = { ...event, x: event.x - this.leftPad, width: inner };
    if (adjusted.y < 0 || adjusted.y >= adjusted.height) return undefined;

    const heights = this.childHeights(inner, event.width);
    let childY = 0;
    for (let index = 0; index < this.children.length; index++) {
      const height = heights[index] ?? 0;
      if (adjusted.y < childY || adjusted.y >= childY + height) {
        childY += height;
        continue;
      }
      const child = this.children[index]!;
      const handled = dispatchToChild(child, { ...adjusted, y: adjusted.y - childY, height });
      if (handled) return handled;
      if (
        this.unhandledClick === undefined ||
        adjusted.type !== 'click' ||
        adjusted.button !== 'left'
      ) {
        return undefined;
      }
      const fallback = this.unhandledClick(index);
      if (fallback === undefined || (!fallback.handled && !fallback.capture && !fallback.focus)) {
        return undefined;
      }
      return {
        handled: true,
        capture: fallback.capture,
        focus: fallback.focus,
        render: fallback.render,
        target: {
          component: this,
          originX: event.screenX - event.x,
          originY: event.screenY - event.y,
          width: event.width,
          height: event.height,
        },
      };
    }
    return undefined;
  }

  private childHeights(innerWidth: number, outerWidth: number): number[] {
    const cache = this.renderCache;
    if (
      cache !== undefined &&
      cache.width === outerWidth &&
      cache.childRefs.length === this.children.length &&
      cache.childRefs.every((child, index) => child === this.children[index])
    ) {
      return cache.prefixed.map((lines) => lines.length);
    }
    return this.children.map((child) => child.render(innerWidth).length);
  }
}

function dispatchToChild(
  child: Component,
  event: TuiMouseEvent,
): TuiMouseDispatchResult | undefined {
  const result = child.handleMouse?.(event);
  if (!result) return undefined;
  if ('target' in result) return result as TuiMouseDispatchResult;
  if (!result.handled && !result.capture && !result.focus) return undefined;
  return {
    ...result,
    handled: true,
    focusTarget: result.focus ? child : undefined,
    target: {
      component: child,
      originX: event.screenX - event.x,
      originY: event.screenY - event.y,
      width: event.width,
      height: event.height,
    },
  };
}
