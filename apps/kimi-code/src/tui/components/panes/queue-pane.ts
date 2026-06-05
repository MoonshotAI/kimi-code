import { Container, Text } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { SELECT_POINTER } from '../../constant/symbols';
import type { QueuedMessage } from '../../types';
import type { ColorPalette } from '../../theme/colors';

export interface QueuePaneOptions {
  readonly messages: readonly QueuedMessage[];
  readonly colors: ColorPalette;
  readonly isCompacting: boolean;
  readonly isStreaming: boolean;
  readonly canSteerImmediately: boolean;
}

export class QueuePaneComponent extends Container {
  constructor(options: QueuePaneOptions) {
    super();

    const accent = chalk.hex(options.colors.accent);
    const dim = chalk.hex(options.colors.textDim);

    for (const item of options.messages) {
      this.addChild(new Text(accent(`  ${SELECT_POINTER} ${item.text}`), 0, 0));
    }

    if (options.messages.length > 0) {
      const hint =
        options.isCompacting && !options.isStreaming
          ? '  ↑ to edit · will send after compaction'
          : !options.canSteerImmediately
            ? '  ↑ to edit · will send after current task'
          : '  ↑ to edit · ctrl-s to steer immediately';
      this.addChild(new Text(dim(hint), 0, 0));
    }
  }
}
