import { Container, Spacer } from '@earendil-works/pi-tui';

import type { MoonLoader } from '../chrome/moon-loader';

export type ActivityPaneMode = 'hidden' | 'waiting' | 'thinking' | 'composing' | 'tool';

export interface ActivityPaneOptions {
  readonly mode: ActivityPaneMode;
  readonly spinner?: MoonLoader;
  readonly tip?: string;
}

export class ActivityPaneComponent extends Container {
  constructor(options: ActivityPaneOptions) {
    super();

    if (options.mode === 'waiting' || options.mode === 'tool') {
      if (options.spinner !== undefined) {
        this.addChild(new Spacer(1));
        this.addChild(options.spinner);
      }
      return;
    }

    if (options.mode === 'composing' && options.spinner !== undefined) {
      this.addChild(new Spacer(1));
      if (options.tip) {
        options.spinner.setTip(` · Tips: ${options.tip}`);
      }
      this.addChild(options.spinner);
    }
  }
}
