import { Container, Spacer } from '@earendil-works/pi-tui';

import type { MoonLoader } from '../chrome/moon-loader';

export type ActivityPaneMode =
  | 'hidden'
  | 'waiting'
  | 'thinking'
  | 'composing'
  | 'tool'
  | 'goal-eval';

export interface ActivityPaneOptions {
  readonly mode: ActivityPaneMode;
  readonly spinner?: MoonLoader;
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

    if (
      (options.mode === 'composing' || options.mode === 'goal-eval') &&
      options.spinner !== undefined
    ) {
      this.addChild(new Spacer(1));
      this.addChild(options.spinner);
    }
  }
}
