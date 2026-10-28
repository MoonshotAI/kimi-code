import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import { SELECT_POINTER } from '../../constant/symbols';
import type { QueuedMessage } from '../../types';
import { DockSection, type DockPart } from '#/tui/components/chrome/dock-section';
import { currentTheme } from '#/tui/theme';

export interface QueuePaneOptions {
  readonly messages: readonly QueuedMessage[];
  readonly isCompacting: boolean;
  readonly isStreaming: boolean;
  readonly canSteerImmediately: boolean;
}

const ELLIPSIS = '…';

/** Queued messages: a rule, one row per message, and the key hint. */
export class QueuePaneComponent extends DockSection {
  private messages: readonly QueuedMessage[] = [];
  private hint: string | undefined;

  setOptions(options: QueuePaneOptions): void {
    this.messages = options.messages;
    if (options.messages.length === 0) {
      this.hint = undefined;
      return;
    }
    // Bash commands (`! …`) are not steerable, and a queued /compact
    // barriers everything behind it — only advertise Ctrl-S when an item
    // ahead of the first /compact would actually steer.
    const firstCompact = options.messages.findIndex((m) => m.mode === 'compact');
    const steerableWindow =
      firstCompact === -1 ? options.messages : options.messages.slice(0, firstCompact);
    const hasSteerable = steerableWindow.some((m) => m.mode !== 'bash');
    const canSteer = options.canSteerImmediately && hasSteerable;
    // A docked list shows only a few rows, so name the total once it scrolls.
    const count =
      this.layout !== undefined && options.messages.length > this.layout.maxBodyRows
        ? `${String(options.messages.length)} queued · `
        : '';
    this.hint =
      options.isCompacting && !options.isStreaming
        ? `  ${count}↑ to edit · will send after compaction`
        : canSteer
          ? `  ${count}↑ to edit · ctrl-s to steer immediately`
          : `  ${count}↑ to edit · will send after current task`;
  }

  protected renderPart(part: DockPart, width: number): string[] {
    if (this.messages.length === 0) return [];
    switch (part) {
      case 'head':
        return [currentTheme.fg('border', '─'.repeat(width))];
      case 'body':
        return this.messages.map((item) => renderItem(item, width));
      case 'foot':
        return this.hint === undefined
          ? []
          : [currentTheme.fg('textDim', truncateToWidth(this.hint, width, ELLIPSIS))];
    }
  }
}

function renderItem(item: QueuedMessage, width: number): string {
  const accent = (text: string) => currentTheme.fg('accent', text);
  const singleLine = item.text.replaceAll(/\s+/g, ' ').trim();
  const prefix = `  ${SELECT_POINTER} `;
  if (item.mode === 'bash') {
    // Shell commands get a `$ ` prompt and the shell-mode hue so they read
    // as commands, not as plain text that would be sent to the model.
    const prompt = '$ ';
    const availableWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(prompt));
    const truncated = truncateToWidth(singleLine, availableWidth, ELLIPSIS);
    return accent(prefix) + currentTheme.fg('shellMode', prompt + truncated);
  }
  const availableWidth = Math.max(1, width - visibleWidth(prefix));
  return accent(prefix + truncateToWidth(singleLine, availableWidth, ELLIPSIS));
}
