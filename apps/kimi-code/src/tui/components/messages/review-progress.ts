import { truncateToWidth, type Component } from '@earendil-works/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme, type ColorToken } from '#/tui/theme';

export type ReviewProgressMessageState =
  | 'started'
  | 'assignment'
  | 'progress'
  | 'comment'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface ReviewProgressMessageData {
  readonly state: ReviewProgressMessageState;
  readonly title: string;
  readonly detail?: string;
}

export class ReviewProgressComponent implements Component {
  constructor(private readonly data: ReviewProgressMessageData) {}

  invalidate(): void {}

  render(width: number): string[] {
    const token = tokenForState(this.data.state);
    const marker = currentTheme.boldFg(token, STATUS_BULLET);
    const title = currentTheme.boldFg(token, this.data.title);
    const lines = ['', marker + title];
    if (this.data.detail !== undefined && this.data.detail.length > 0) {
      lines.push(`  ${currentTheme.fg('textDim', this.data.detail)}`);
    }
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function tokenForState(state: ReviewProgressMessageState): ColorToken {
  switch (state) {
    case 'completed':
      return 'success';
    case 'cancelled':
      return 'textDim';
    case 'failed':
      return 'error';
    default:
      return 'primary';
  }
}
