import type { Component } from '@moonshot-ai/pi-tui';

import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { currentTheme } from '#/tui/theme';

/**
 * A collapsed summary of older content within a turn. Accumulates counts of
 * merged steps (thinking blocks and tool calls) and folded assistant messages.
 * The count stays as a single muted line until Ctrl+O reveals lightweight
 * snapshots of the folded assistant messages, e.g.
 * `… thinking 5 times, call 50 tools, 12 messages`.
 */
export class StepSummaryComponent implements Component {
  private thinking = 0;
  private tool = 0;
  private message = 0;
  private foldedMessageContent: string[] = [];
  private expandedMessageRenderCache: { width: number; lines: string[] } | undefined;
  private expanded = false;

  get isEmpty(): boolean {
    return this.thinking === 0 && this.tool === 0 && this.message === 0;
  }

  addCounts(thinking: number, tool: number, message = 0): void {
    this.thinking += thinking;
    this.tool += tool;
    this.message += message;
  }

  addFoldedMessages(messages: readonly AssistantMessageComponent[]): void {
    for (const message of messages) {
      const content = message.getContent();
      if (content.length > 0) this.foldedMessageContent.push(content);
    }
    this.expandedMessageRenderCache = undefined;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    if (!expanded) this.expandedMessageRenderCache = undefined;
  }

  invalidate(): void {
    this.expandedMessageRenderCache = undefined;
  }

  render(width: number): string[] {
    const parts: string[] = [];
    if (this.thinking > 0) parts.push(`thinking ${this.thinking} times`);
    if (this.tool > 0) parts.push(`call ${this.tool} tools`);
    if (this.message > 0) parts.push(`${this.message} messages`);
    if (parts.length === 0) return [];
    const lines = [currentTheme.dim(`\u2026 ${parts.join(', ')}`)];
    if (!this.expanded || this.foldedMessageContent.length === 0) return lines;

    if (this.expandedMessageRenderCache?.width !== width) {
      // Reuse one Markdown renderer so a very long turn does not rebuild an
      // equally large component tree when its folded messages are expanded.
      const message = new AssistantMessageComponent();
      const expandedLines: string[] = [];
      for (const content of this.foldedMessageContent) {
        message.updateContent(content);
        expandedLines.push(...message.render(width));
      }
      this.expandedMessageRenderCache = { width, lines: expandedLines };
    }
    lines.push(...this.expandedMessageRenderCache.lines);
    return lines;
  }
}
