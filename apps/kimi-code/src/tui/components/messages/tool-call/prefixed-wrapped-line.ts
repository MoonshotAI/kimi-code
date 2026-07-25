/**
 * PrefixedWrappedLine — a Component that wraps text with a prefix on the
 * first line and a continuation prefix on subsequent lines.
 *
 * Extracted from tool-call.ts as a self-contained rendering primitive
 * used by the subagent single-card view.
 */

import { Text, truncateToWidth, visibleWidth, type Component } from '@moonshot-ai/pi-tui';

import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

export class PrefixedWrappedLine implements Component {
  private renderCache: { width: number; lines: string[] } | undefined;

  constructor(
    private readonly firstPrefix: string,
    private readonly continuationPrefix: string,
    private readonly text: string,
    private readonly tailLines?: number,
    private readonly minLines?: number,
  ) {}

  invalidate(): void {
    this.renderCache = undefined;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    if (isRenderCacheEnabled() && this.renderCache?.width === safeWidth) {
      return this.renderCache.lines;
    }

    const prefixWidth = Math.max(
      visibleWidth(this.firstPrefix),
      visibleWidth(this.continuationPrefix),
    );
    const contentWidth = Math.max(1, safeWidth - prefixWidth);
    const wrapped = new Text(this.text, 0, 0).render(contentWidth);
    const lines =
      this.tailLines !== undefined && wrapped.length > this.tailLines
        ? wrapped.slice(wrapped.length - this.tailLines)
        : wrapped;
    if (this.minLines !== undefined) {
      while (lines.length < this.minLines) lines.push('');
    }
    const rendered = lines
      .map((line, index) =>
        index === 0 ? `${this.firstPrefix}${line}` : `${this.continuationPrefix}${line}`,
      )
      .map((line) => truncateToWidth(line, safeWidth, '…'));
    if (isRenderCacheEnabled()) {
      this.renderCache = { width: safeWidth, lines: rendered };
    }
    return rendered;
  }
}
