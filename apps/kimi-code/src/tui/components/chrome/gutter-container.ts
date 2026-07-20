/**
 * Container that reserves left/right gutter columns around its children,
 * so the chrome (statusline, transcript, panels) lines up with the input
 * box's inner content area instead of butting up against the terminal edge.
 *
 * Children are rendered at `width - left - right` and each emitted line is
 * prefixed with `left` plain spaces. Right padding is logical only — we
 * never emit trailing spaces, since terminals already paint background to
 * the edge and adding them would just churn the diff renderer.
 */

import { Container } from '@moonshot-ai/pi-tui';
import type { Component } from '@moonshot-ai/pi-tui';

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
        prefixed.push(lines.map((line) => lead + line));
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
}
