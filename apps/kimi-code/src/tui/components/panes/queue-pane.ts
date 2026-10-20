import { Container, truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import { SELECT_POINTER } from '../../constant/symbols';
import type { QueuedMessage } from '../../types';
import { currentTheme } from '#/tui/theme';

export interface QueuePaneOptions {
  readonly messages: readonly QueuedMessage[];
  readonly isCompacting: boolean;
  readonly isStreaming: boolean;
  readonly canSteerImmediately: boolean;
}

const ELLIPSIS = '…';

export class QueuePaneComponent extends Container {
  private readonly messages: readonly QueuedMessage[];
  private readonly hint: string | undefined;

  constructor(options: QueuePaneOptions) {
    super();
    this.messages = options.messages;

    if (options.messages.length > 0) {
      // Bash commands (`! …`) are not steerable, and a queued /compact
      // barriers everything behind it — only advertise Ctrl-S when an item
      // ahead of the first /compact would actually steer.
      const firstCompact = options.messages.findIndex((m) => m.mode === 'compact');
      const steerableWindow =
        firstCompact === -1 ? options.messages : options.messages.slice(0, firstCompact);
      const hasSteerable = steerableWindow.some((m) => m.mode !== 'bash');
      const canSteer = options.canSteerImmediately && hasSteerable;
      this.hint =
        options.isCompacting && !options.isStreaming
          ? '  ↑ to edit · will send after compaction'
          : canSteer
            ? '  ↑ to edit · ctrl-s to steer immediately'
            : '  ↑ to edit · will send after current task';
    }
  }

  override render(width: number): string[] {
    const accent = (text: string) => currentTheme.fg('accent', text);
    const shell = (text: string) => currentTheme.fg('shellMode', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const lines: string[] = [currentTheme.fg('border', '─'.repeat(width))];

    for (const item of this.messages) {
      const singleLine = item.text.replaceAll(/\s+/g, ' ').trim();
      const prefix = `  ${SELECT_POINTER} `;
      if (item.mode === 'bash') {
        // Shell commands get a `$ ` prompt and the shell-mode hue so they read
        // as commands, not as plain text that would be sent to the model.
        const prompt = '$ ';
        const availableWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(prompt));
        const truncated = truncateToWidth(singleLine, availableWidth, ELLIPSIS);
        lines.push(accent(prefix) + shell(prompt + truncated));
      } else {
        const availableWidth = Math.max(1, width - visibleWidth(prefix));
        const truncated = truncateToWidth(singleLine, availableWidth, ELLIPSIS);
        lines.push(accent(prefix + truncated));
      }
    }

    if (this.hint !== undefined) {
      lines.push(dim(truncateToWidth(this.hint, width, ELLIPSIS)));
    }

    return lines;
  }
}
