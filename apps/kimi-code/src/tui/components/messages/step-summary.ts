import type { Component } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
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
    if (this.thinking > 0) {
      parts.push(
        t(
          this.thinking === 1
            ? 'tui.messages.stepSummary.thinking_one'
            : 'tui.messages.stepSummary.thinking_other',
          { count: this.thinking },
        ),
      );
    }
    if (this.tool > 0) {
      parts.push(
        t(
          this.tool === 1
            ? 'tui.messages.stepSummary.tool_one'
            : 'tui.messages.stepSummary.tool_other',
          { count: this.tool },
        ),
      );
    }
    if (parts.length === 0) return [];
    return [currentTheme.dim(`\u2026 ${parts.join(', ')}`)];
  }
}
