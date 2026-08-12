import { Container, Spacer, Text } from '@moonshot-ai/pi-tui';

import type { MoonLoader } from '#/tui/components/chrome/moon-loader';
import { ACTIVITY_DETAIL_INDENT } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';

export type ActivityPaneMode = 'hidden' | 'waiting' | 'thinking' | 'composing' | 'tool';

export interface ActivityPaneOptions {
  readonly mode: ActivityPaneMode;
  readonly spinner?: MoonLoader;
  readonly tip?: string;
  /** Extra dim line rendered under the spinner (e.g. step retry error detail). */
  readonly detail?: string;
}

export function formatActivitySpinnerTip(tip: string | undefined): string {
  return tip === undefined || tip.length === 0 ? '' : ` · Tip: ${tip}`;
}

export class ActivityPaneComponent extends Container {
  private spinnerRef?: MoonLoader;

  constructor(options: ActivityPaneOptions) {
    super();
    this.spinnerRef = options.spinner;

    if (
      (options.mode === 'waiting' || options.mode === 'tool' || options.mode === 'composing') &&
      options.spinner !== undefined
    ) {
      this.addChild(new Spacer(1));
      options.spinner.setTip(formatActivitySpinnerTip(options.tip));
      this.addChild(options.spinner);
      if (options.detail !== undefined && options.detail.length > 0) {
        this.addChild(new Text(currentTheme.fg('textDim', options.detail), ACTIVITY_DETAIL_INDENT, 0));
      }
    }
  }

  override render(width: number): string[] {
    if (this.spinnerRef && 'setAvailableWidth' in this.spinnerRef) {
      this.spinnerRef.setAvailableWidth(width);
    }
    return super.render(width);
  }
}
