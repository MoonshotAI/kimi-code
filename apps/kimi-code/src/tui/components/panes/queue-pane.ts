import { Container, Text } from '@earendil-works/pi-tui';

import { SELECT_POINTER } from '../../constant/symbols';
import type { QueuedMessage } from '../../types';
import { currentTheme } from '#/tui/theme';

export interface QueuePaneOptions {
  readonly messages: readonly QueuedMessage[];
  readonly isCompacting: boolean;
  readonly isStreaming: boolean;
  readonly canSteerImmediately: boolean;
}

export class QueuePaneComponent extends Container {
  private readonly options: QueuePaneOptions;

  constructor(options: QueuePaneOptions) {
    super();
    this.options = options;
    this.rebuildChildren();
  }

  override invalidate(): void {
    this.rebuildChildren();
    super.invalidate();
  }

  private rebuildChildren(): void {
    this.clear();
    const accent = (text: string) => currentTheme.fg('accent', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);

    for (const item of this.options.messages) {
      this.addChild(new Text(accent(`  ${SELECT_POINTER} ${item.text}`), 0, 0));
    }

    if (this.options.messages.length > 0) {
      const hint =
        this.options.isCompacting && !this.options.isStreaming
          ? '  ↑ to edit · will send after compaction'
          : !this.options.canSteerImmediately
            ? '  ↑ to edit · will send after current task'
            : '  ↑ to edit · ctrl-s to steer immediately';
      this.addChild(new Text(dim(hint), 0, 0));
    }
  }
}
