import type { Component } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

/**
 * A collapsed summary of older steps within a turn. Accumulates counts of
 * merged steps (thinking blocks and tool calls) and renders them as a single
 * muted line, e.g. `… thinking 5 times, call 50 tools`.
 */
export class StepSummaryComponent implements Component {
  private thinking = 0;
  private tool = 0;

  get isEmpty(): boolean {
    return this.thinking === 0 && this.tool === 0;
  }

  addCounts(thinking: number, tool: number): void {
    this.thinking += thinking;
    this.tool += tool;
  }

  invalidate(): void {}

  render(_width: number): string[] {
    const parts: string[] = [];
    if (this.thinking > 0) parts.push(`thinking ${this.thinking} times`);
    if (this.tool > 0) parts.push(`call ${this.tool} tools`);
    if (parts.length === 0) return [];
    return [currentTheme.dim(`\u2026 ${parts.join(', ')}`)];
  }
}
