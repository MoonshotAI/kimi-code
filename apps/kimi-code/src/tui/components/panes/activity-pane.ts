import { Container, Spacer, Text, TruncatedText, type Component } from '@moonshot-ai/pi-tui';

import type { MoonLoader } from '#/tui/components/chrome/moon-loader';
import { ACTIVITY_DETAIL_INDENT } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';
import { workedSummary } from '#/tui/utils/activity-label';
import type { TimelineReader } from '#/tui/utils/turn-timeline';

export type ActivityPaneMode = 'hidden' | 'waiting' | 'thinking' | 'composing' | 'tool' | 'compacting';

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
      (options.mode === 'waiting' ||
        options.mode === 'tool' ||
        options.mode === 'composing' ||
        options.mode === 'thinking' ||
        options.mode === 'compacting') &&
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

export class LastTurnSummary implements Component {
  constructor(private readonly timeline: Pick<TimelineReader, 'turn'>) {}

  render(width: number): string[] {
    return new TruncatedText(currentTheme.fg('textDim', workedSummary(this.timeline.turn())), 1, 0).render(width);
  }

  invalidate(): void {}
}
