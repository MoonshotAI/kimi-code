import { Container, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

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
      this.hint =
        options.isCompacting && !options.isStreaming
          ? '  ↑ to edit · will send after compaction'
          : !options.canSteerImmediately
            ? '  ↑ to edit · will send after current task'
            : '  ↑ to edit · ctrl-s to steer immediately';
    }
  }

  override render(width: number): string[] {
    const accent = (text: string) => currentTheme.fg('accent', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const lines: string[] = [];

    for (const item of this.messages) {
      const singleLine = item.text.replaceAll(/\s+/g, ' ').trim();
      const prefix = `  ${SELECT_POINTER} `;
      const availableWidth = Math.max(1, width - visibleWidth(prefix));
      const truncated = truncateToWidth(singleLine, availableWidth, ELLIPSIS);
      lines.push(accent(prefix + truncated));
    }

    if (this.hint !== undefined) {
      lines.push(dim(truncateToWidth(this.hint, width, ELLIPSIS)));
    }

    return lines;
  }
}
